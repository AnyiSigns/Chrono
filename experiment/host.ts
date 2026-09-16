// 宿主最小闭环：落盘 + 真打 HTTP + 崩溃重启 replay——续跑契约 waiting→回灌→done 完整跑一圈。
// （体量口径：150 行是压行前的语句数；仓库 Prettier 行宽口径拆行后 ~340 行，行为同一份。）
//   node host.ts         r-1 到 waiting#1：真取 zen、结果入账写台账 → exit(9) 模拟崩溃（世界分文未动）
//   node host.ts resume  冷启动快档取用（assemble("partial")，无快照边界时退化为 replay-only）→
//                        同 run_id/now/directives 续调（zen 不重取，结果从台账来）→ waiting#2 取
//                        example → 回灌 → done；再 r-2（schema 门禁 + 源码入世 + 身份/世代）→
//                        refused 演示 → 落盘后的重启对账（partial ≡ full）
//   node host.ts boot    深度启动自检：assemble("full") = verify 全链 + replay 全量。清空重来：删 host-state/
// 端口实现走 node:https 而非 fetch：undici keep-alive 句柄会让 Windows 上的崩溃退出触发 libuv 断言。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  H,
  anchorAfter,
  entryHash,
  replay,
  run,
  verify,
  worldRev,
} from "../packages/kernel/index.ts";
import type {
  Def,
  Directive,
  EffResult,
  Entry,
  Head,
  Hash,
  Json,
  KernelInput,
  KernelOutput,
  World,
} from "../packages/kernel/index.ts";

const NOW1 = 1_758_000_000_000,
  NOW2 = 1_758_000_000_500,
  LIM = { gas: 1000, depth: 8 };
const CAPS: Record<string, boolean> = { net: true };
const DIR = join(import.meta.dirname as string, "host-state");
const FJ = join(DIR, "journal.jsonl"),
  FI = join(DIR, "inflight.json"); // 基础校验走 §6 三步成对（assemble），不再另存 rev 土办法
mkdirSync(DIR, { recursive: true });
const srcText =
  "export function render(req) {\n  // " + "z".repeat(100_000) + "\n}";
const srcDef: Def = { body: { lang: "ts", entry: "render", text: srcText } };
const key = (d: Def): Hash => H(d);
const K_SRC = key(srcDef);
const probe = (url: string): Def => ({
  body: ["eff", "net", "http.get", ["c", { url }]],
});
const zenDef = probe("https://api.github.com/zen");
const siteDef = probe("https://example.com/");
// 规矩 A 生效：结构性依赖只写 pins——body 不重复列同一个哈希（哈希只能是业务数据值）
const manDef: Def = { body: { lang: "ts" }, pins: { src: K_SRC } };
const sigDef: Def = { body: ["c", "render-sig-0"] };
// 第一份 schema def = 可执行 term：该类型身份的 pins 必须含名为 src 的项（缺即 walk 抛
// missing_path）。门禁落在数据上、宿主在 add_gen 前求值——M2 归约机的第一个真实用户。
const schemaDef: Def = { body: ["g", ["pins", "src"]] };
let exitCode = 0;
function check(name: string, isPass: boolean, note = ""): void {
  if (!isPass) exitCode = 1;
  console.log(`${isPass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
}
function httpGet(url: string): Promise<EffResult> {
  const lib = url.startsWith("https:") ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(
      url,
      { headers: { "user-agent": "kernel-host-demo", accept: "*/*" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on(
          "data",
          (c: string) => void (body = body.length < 2000 ? body + c : body),
        );
        res.on("end", () =>
          resolve({
            ok: true,
            value: { status: res.statusCode ?? 0, body: body.slice(0, 2000) },
          }),
        );
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(15_000, () => req.destroy(new Error("http_timeout")));
  });
}
// Buffer 按字节切行：整本读单串在 >536MB 必触 V8 上限（bench C 段实测 RangeError）
function loadEntries(): Entry[] {
  if (!existsSync(FJ)) return [];
  const buf = readFileSync(FJ);
  const out: Entry[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(JSON.parse(buf.toString("utf8", start, i)) as Entry);
      start = i + 1;
    }
  }
  return out;
}
// ── 取用三模式（§6）：assemble 让"基础 + 补丁链"成为一处代码。partial = ① 校基础 →
// ② 校接驳（尾段）→ ③ 才 replay 出状态——三步成对是硬规则（replay 单用会把接错的尾巴当合法历史）。
type BootMode = "full" | "partial" | "base_only";
function headAfter(entries: Entry[]): Head {
  const last = entries[entries.length - 1];
  return last ? { seq: last.seq, hash: entryHash(last) } : EMPTY_HEAD;
}
function snapPath(seq: number): string {
  return join(DIR, `snap-${seq}.json`);
}
function saveSnap(w: World, seq: number): void {
  writeFileSync(snapPath(seq), JSON.stringify(w));
  const keep = `snap-${seq}.json`;
  for (const f of readdirSync(DIR))
    if (/^snap-\d+\.json$/.test(f) && f !== keep) rmSync(join(DIR, f)); // 只留最近边界（节拍=宿主策略）
}
function readSnap(snap: Entry): World {
  const p = snapPath(snap.seq);
  if (!existsSync(p)) throw new Error(`快照本体缺失：${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as World;
}
// 最近一条 snapshot 的数组下标；无 = -1（边界即凭证：args.world_rev + 本体文件 + 该 entry 的位置）
function snapshotIndex(entries: Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].op === "snapshot") return i;
  return -1;
}
function assemble(mode: BootMode): { world: World; head: Head | null } {
  const entries = loadEntries();
  if (mode === "full") {
    // full 起点是冻结常量 EMPTY_WORLD——无需校基础，深度档付 verify + replay 两趟
    const v = verify(entries);
    check(`full 深度自检 verify 全链（${entries.length} 条）`, v.ok, v.error ?? "");
    if (!v.ok) throw new Error(`全链校验失败，拒绝挂载：${v.error}`);
    return { world: replay(entries), head: headAfter(entries) };
  }
  const si = snapshotIndex(entries);
  if (si < 0) {
    // 无边界：base_only 即空基座只读投影；快档起点是冻结常量可跳 ①，只付 replay 一趟
    if (mode === "base_only") return { world: EMPTY_WORLD, head: null };
    return { world: replay(entries), head: headAfter(entries) };
  }
  const snap = entries[si];
  const base = readSnap(snap);
  const anchor = anchorAfter(base, snap);
  // ① 校基础——内核里唯一能校验基础的入口（空段只剩 worldRev 比对）；取代旧 rev 存档土办法
  const v1 = verify([], anchor, {
    worldRev: (snap.args as { world_rev: string }).world_rev,
  });
  check("① 校基础（快照锚点 vs 存档本体）", v1.ok, v1.error ?? "");
  if (!v1.ok) throw new Error(`基础校验失败，拒绝挂载：${v1.error}`);
  if (mode === "base_only") return { world: base, head: null }; // 禁写：pos 是链头哈希，基础里根本没有
  const tail = entries.slice(si + 1);
  const v2 = verify(tail, anchor); // ② 校接驳
  check(`② 校接驳（尾段 ${tail.length} 条）`, v2.ok, v2.error ?? "");
  if (!v2.ok) throw new Error(`尾段校验失败，拒绝挂载：${v2.error}`);
  return { world: replay(tail, base), head: tail.length ? headAfter(tail) : anchor.head }; // ③
}
// 快启动 = partial（无快照边界时自动退化为 replay-only，冷启动不付全量审计）；深度档 = full 两趟
function coldBoot(isDeep: boolean): { world: World; head: Head } {
  const made = assemble(isDeep ? "full" : "partial");
  return { world: made.world, head: made.head as Head }; // full/partial 恒有位点可接
}
// 快照节拍 = 每个 done 一条（宿主策略，§10.7-5）：snapshot entry 走唯一写口 append，
// 世界随该边界落盘成 snap-<seq>.json——它就是取用三模式里被 ① 校验的那个"基础"。
function mountSnapshot(w: World, h: Head, now: number): KernelOutput | null {
  const out = run({
    world: w,
    head: h,
    run: `snap-${h.seq + 1}`,
    now,
    caps: CAPS,
    limits: LIM,
    results: {},
    directives: [
      {
        kind: "write",
        request: {
          id: `snap-${h.seq + 1}`,
          op: "snapshot",
          target: { expect_pos: h.hash },
          args: { world_rev: worldRev(w) },
          by: "host",
        },
      },
    ],
  });
  if (out.status !== "done")
    throw new Error(
      `snapshot 被拒：${JSON.stringify(out.observations[out.observations.length - 1])}`,
    );
  out.journal.forEach((e) => appendFileSync(FJ, JSON.stringify(e) + "\n"));
  saveSnap(out.world, out.head.seq);
  return out;
}
async function drive(
  inp: KernelInput,
  isCrashArmed: boolean,
): Promise<KernelOutput> {
  let i = inp;
  for (;;) {
    const out = run(i);
    if (out.status !== "waiting" || !out.pending) {
      if (out.status === "done") {
        out.journal.forEach((e) =>
          appendFileSync(FJ, JSON.stringify(e) + "\n"),
        );
        const snap = mountSnapshot(out.world, out.head, i.now);
        rmSync(FI, { force: true });
        return snap ? { ...out, world: snap.world, head: snap.head } : out;
      }
      return out;
    }
    const p = out.pending;
    const res =
      p.port === "net" && p.method === "http.get"
        ? await httpGet(String((p.args as { url: Json }).url))
        : { ok: false, error: "no_such_port" };
    i = { ...i, results: { ...i.results, [p.id]: res } };
    writeFileSync(
      FI,
      JSON.stringify({
        run: i.run,
        now: i.now,
        directives: i.directives,
        results: i.results,
      }),
    ); // 台账先落盘才推进
    console.log(
      `   waiting(${p.id.slice(0, 8)}…) ${p.port}.${p.method} 已真实执行、结果已入账`,
    );
    if (isCrashArmed) {
      console.log(
        "   —— 模拟崩溃 exit(9)：未及回灌重调；journal 与 world 分文未动。下跑 `host.ts resume` ——",
      );
      process.exitCode = 9;
      return out;
    }
  }
}
const dir = (id: string, ops: Json[], pos: Hash | null): Directive => ({
  kind: "write",
  request: {
    id,
    op: "batch",
    target: { expect_pos: pos },
    args: { ops },
    by: "host",
  },
});
const opPut = (d: Def): Json => ({ op: "put", args: d });

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  const { world, head } = coldBoot(mode === "boot");
  if (mode === "boot") return void (process.exitCode = exitCode);
  const fi = existsSync(FI)
    ? (JSON.parse(readFileSync(FI, "utf8")) as Pick<
        KernelInput,
        "run" | "now" | "directives" | "results"
      >)
    : null;
  if (fi)
    console.log(
      "   发现台账——以同一 run_id/now/directives 重进 r-1（台账里的 zen 直接复用，不再取）",
    );
  const out1 = await drive(
    fi
      ? {
          world,
          head,
          caps: CAPS,
          limits: LIM,
          run: fi.run,
          now: fi.now,
          directives: fi.directives,
          results: fi.results,
        }
      : {
          world,
          head,
          caps: CAPS,
          limits: LIM,
          run: "r-1",
          now: NOW1,
          results: {},
          directives: [
            dir(
              "r1-seed",
              [opPut(srcDef), opPut(zenDef), opPut(siteDef)],
              head.hash,
            ),
            { kind: "eval", entry: key(zenDef), args: null, ctx: {} },
            { kind: "eval", entry: key(siteDef), args: null, ctx: {} },
          ],
        },
    mode === "" && !fi,
  );
  if (out1.status === "waiting") return; // 崩溃离场：exitCode=9 已设
  check("续跑契约 r-1 waiting→回灌→done", out1.status === "done", out1.status);
  if (out1.status !== "done") return void (process.exitCode = exitCode);
  const ev = (e: Hash) =>
    (out1.observations as { kind?: string; entry?: Hash; value?: Json }[]).find(
      (o) => o.kind === "eval" && o.entry === e,
    )?.value;
  const zen = ev(key(zenDef)) as { status: number; body: string };
  const site = ev(key(siteDef)) as { status: number; body: string };
  check(
    "真实 HTTP 结果进了内核观测",
    zen.status === 200 && site.status === 200,
    `zen='${zen.body.trim().slice(0, 24)}…'`,
  );
  check(
    "r-1 世界含 100KB 源码 def（源码以数据身份入世）",
    (
      (out1.world.defs[K_SRC] as Def | undefined)?.body as
        { text: string } | undefined
    )?.text?.length === srcText.length,
  );
  const sumDef: Def = {
    body: {
      plugin: "render",
      src: K_SRC,
      zen: zen.body.trim().slice(0, 60),
      site_kb: Math.round(site.body.length / 1e2),
    },
  };
  // 门禁在 add_gen 之前求值（M2 真实用户）：schema term 从世界执行，判定落在数据上。
  // 先单独一步把 schema def 写入世界（r-2a），门禁求值的 entry 必须已在 defs。
  const out2a = await drive(
    {
      world: out1.world,
      head: out1.head,
      caps: CAPS,
      limits: LIM,
      run: "r-2a",
      now: NOW2,
      results: {},
      directives: [dir("r2-schema", [opPut(schemaDef)], out1.head.hash)],
    },
    false,
  );
  const gateEval = (genCandidate: Json) =>
    run({
      world: out2a.world,
      head: out2a.head,
      caps: CAPS,
      limits: LIM,
      run: "gate",
      now: NOW2,
      results: {},
      directives: [
        {
          kind: "eval",
          entry: key(schemaDef),
          args: genCandidate,
          ctx: genCandidate,
        },
      ],
    });
  const genOk: Json = {
    id: "render",
    payload: key(manDef),
    pins: { src: K_SRC },
    sig: key(sigDef),
  };
  const gate = gateEval(genOk);
  const gateObs = gate.observations[gate.observations.length - 1] as {
    kind?: string;
    value?: Json;
    reasons?: string[];
  };
  check(
    "schema 门禁：声明了 pins.src 的 gen 放行（term 在世界中求值得到 pin 值）",
    gate.status === "done" && gateObs?.value === K_SRC,
    `status=${gate.status}`,
  );
  const genNoPins: Json = {
    id: "render",
    payload: key(manDef),
    sig: key(sigDef),
  };
  const gateBad = gateEval(genNoPins);
  const gateBadReasons = (
    gateBad.observations[gateBad.observations.length - 1] as {
      reasons?: string[];
    }
  )?.reasons;
  check(
    "schema 门禁：漏 pins.src 能拒——内核 validate 会放行，拒必须来自数据判据",
    gateBad.status === "refused" &&
      (gateBadReasons ?? []).includes("missing_path") &&
      gateBad.world === out2a.world &&
      gateBad.head === out2a.head,
  );
  // 依赖声明必须走 pins——stale() 只有 pins 一个可比维度，body 内的引用是 opaque（可达闭包归上层）
  const out2 = await drive(
    {
      world: out2a.world,
      head: out2a.head,
      caps: CAPS,
      limits: LIM,
      run: "r-2b",
      now: NOW2,
      results: {},
      directives: [
        dir(
          "r2-lineage",
          [
            { op: "put", args: sumDef },
            { op: "put", args: sigDef },
            opPut(manDef),
            {
              op: "add_identity",
              args: { id: "render", schema: key(schemaDef) },
            },
            {
              op: "add_gen",
              args: {
                id: "render",
                payload: { $n: 2 },
                pins: { src: K_SRC },
                sig: { $n: 1 },
              },
            },
          ],
          out2a.head.hash,
        ),
      ],
    },
    false,
  );
  const idm = out2.world.ids["render"];
  check(
    "r-2：身份注册（schema=门禁 term）+ 世代激活指向 manifest（pins.src 挂载可供 stale 比对）",
    out2.status === "done" &&
      idm?.active === key(manDef) &&
      idm?.schema === key(schemaDef) &&
      idm?.gens[0]?.pins.src === K_SRC,
  );
  check(
    "规矩 A：manifest 哈希只在 pins——body 里无 64-hex（单一记录处，防两处漂移）",
    !/[0-9a-f]{64}/.test(JSON.stringify(manDef.body)) &&
      manDef.pins?.src === K_SRC,
  );
  const sizeBefore = statSync(FJ).size;
  const out3 = run({
    world: out2.world,
    head: out2.head,
    caps: CAPS,
    limits: LIM,
    run: "r-bad",
    now: NOW2 + 1,
    results: {},
    directives: [
      dir("stale-attempt", [{ op: "note", args: {} } as Json], "0".repeat(64)),
    ],
  });
  const lastObs = out3.observations[out3.observations.length - 1] as {
    reasons?: string[];
  };
  check(
    "refused：pos_conflict 整次作废，链头/落盘分文未动",
    out3.status === "refused" &&
      out3.journal.length === 0 &&
      out3.head === out2.head &&
      statSync(FJ).size === sizeBefore &&
      (lastObs.reasons ?? []).includes("pos_conflict"),
  );
  const ctxView = assemble("base_only"); // 只读投影（上下文/检索用途）：只有 ①，没有可接写的位置
  check(
    "base_only 取用 = 只读投影（head=null 不可提写，§6 禁则）",
    ctxView.head === null && ctxView.world.defs[K_SRC] !== undefined,
  );
  // 重启对账不再靠另存 rev：partial 三步成对的结果必须与 full 全量逐字节相同（H(世界) 相等）
  const rePart = assemble("partial");
  const reFull = assemble("full");
  check(
    "落盘后的重启：partial(①②③) 取回 100KB 源码全文，世界 ≡ full 全量组装",
      (
        (rePart.world.defs[K_SRC] as Def | undefined)?.body as
          { text: string } | undefined
      )?.text?.length === srcText.length &&
      H(rePart.world) === H(reFull.world),
  );
  console.log(
    exitCode === 0
      ? "结论：150 行宿主把续跑契约完整跑通——前面记的账开始还。"
      : "结论：有 ✗——抽象或宿主代码错了，现场如上。",
  );
  process.exitCode = exitCode;
}
main().catch((err) => {
  console.error("宿主异常：", err);
  process.exit(1);
});
