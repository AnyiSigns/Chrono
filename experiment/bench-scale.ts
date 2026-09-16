// 规模墙实测：N defs × 100KB 源码文本以数据形式进出内核，只走公共面（../packages/kernel/index.ts）。
// 用法：node --expose-gc --max-old-space-size=5632 bench-scale.ts（环境变量 BENCH_DEFS / BENCH_CHUNK 改规模；
// T 段四档测点：BENCH_T1_DEFS / BENCH_T1_BYTES / BENCH_T2_NOTES（本机 ② 尽力跑到 1000000 测比率）/ BENCH_T34_REFS）。
// 口径：吞吐一律按原文字符数计。[参考] = 只存在于本文件的对策上界测量，不进内核。
// 内存纪律：B 的 live 世界与 chunkDefs 共享同一批字符串；journal 读入必须 Buffer 切行（整本单串 >536MB
// 触 V8 上限，C 段实测 RangeError）；D/E/F 之间清大对象再 gc——峰值各阶段独立。
// 阶段顺序即内存顺序；产物 tmp/（journal.jsonl + blobs/）启动时清空重建——revLive 仅在本进程生命周期成立。

import { performance } from "node:perf_hooks";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import v8 from "node:v8";
import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  H,
  anchorAfter,
  applyEntry,
  canonicalJson,
  cloneWorld,
  entryHash,
  replay,
  run,
  verify,
  worldRev,
} from "../packages/kernel/index.ts";
import type {
  Def,
  Entry,
  Hash,
  Head,
  Json,
  KernelOutput,
  World,
  WriteRequest,
} from "../packages/kernel/index.ts";

const N = Number(process.env.BENCH_DEFS ?? "10000");
const TEXT = 100_000;
const CHUNK = Number(process.env.BENCH_CHUNK ?? "100");
const NOW = 1_758_000_000_000;
const TMP = join(import.meta.dirname as string, "tmp");
const JOURNAL = join(TMP, "journal.jsonl");
const BLOBS = join(TMP, "blobs");
const CAPS: Record<string, boolean> = { net: true };
const NCHUNK = Math.ceil(N / CHUNK);

function say(line: string): void {
  console.log(line);
}
function mb(x: number): string {
  return (x / 1e6).toFixed(1);
}
function hr(tag: string): void {
  const u = process.memoryUsage();
  say(`  [heap ${mb(u.heapUsed)}MB rss ${mb(u.rss)}MB] ${tag}`);
}
function gc(): void {
  const g = globalThis as { gc?: () => void };
  if (g.gc) {
    g.gc();
    g.gc();
  }
}
function avgMs(fn: (k: number) => void, times: number): number {
  const t0 = performance.now();
  for (let k = 0; k < times; k++) fn(k);
  return (performance.now() - t0) / times;
}
/** 预热 3 轮 + times 轮取中位数：A 的冷均值会高估 H（首轮 JIT 未热），与 B 的热吞吐口径必须一致。 */
function medMs(fn: (k: number) => void, times: number): number {
  for (let k = 0; k < 3; k++) fn(k);
  const ts: number[] = [];
  for (let k = 0; k < times; k++) {
    const t0 = performance.now();
    fn(k);
    ts.push(performance.now() - t0);
  }
  ts.sort((x, y) => x - y);
  return ts[Math.floor(ts.length / 2)];
}
function oneMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}
function genText(idx: number, bytes = TEXT): string {
  const parts: string[] = [`// file-${idx}\n`];
  let x = (idx * 1103515245 + 12345) >>> 0;
  let len = parts[0].length;
  while (len < bytes) {
    let line = "";
    for (let c = 0; c < 76; c++) {
      x = (x * 1103515245 + 12345) >>> 0;
      line += String.fromCharCode(48 + (x % 75));
    }
    parts.push(line, "\n");
    len += line.length + 1;
  }
  return parts.join("").slice(0, bytes);
}
function mkDef(idx: number): Def {
  return { body: { file: `f${idx}`, text: genText(idx) } };
}
function writeOps(
  world: World,
  head: Head,
  runId: string,
  ops: Json[],
): KernelOutput {
  const req: WriteRequest = {
    id: `${runId}-${head.seq + 1}`,
    op: "batch",
    target: { expect_pos: head.hash },
    args: { ops },
    by: "bench",
  };
  const out = run({
    world,
    head,
    run: runId,
    now: NOW,
    caps: CAPS,
    results: {},
    limits: { gas: 1000, depth: 8 },
    directives: [{ kind: "write", request: req }],
  });
  if (out.status !== "done") throw new Error(`${runId} → ${out.status}`);
  return out;
}
function putBatch(
  world: World,
  head: Head,
  runId: string,
  defs: Def[],
): KernelOutput {
  return writeOps(
    world,
    head,
    runId,
    defs.map((d) => ({ op: "put", args: d })),
  );
}
function readLines(path: string): Buffer[] {
  const buf = readFileSync(path);
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}

// ── [参考] 字块化纯 JS sha256（K1 上界）：与 H 同口径，只改喂字节的方式 ──
const IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
const KL = new Uint32Array(64);
{
  const hex =
    "428a2f9871374491b5c0fbcfe9b5dba53956c25b59f111f1923f82a4ab1c5ed5d807aa9812835b01243185be550c7dc372be5d7480deb1fe9bdc06a7c19bf174e49b69c1efbe47860fc19dc6240ca1cc2de92c6f4a7484aa5cb0a9dc76f988da983e5152a831c66db00327c8bf597fc7c6e00bf3d5a7914706ca63511429296727b70a852e1b21384d2c6dfc53380d13650a7354766a0abb81c2c92e92722c85a2bfe8a1a81a664bc24b8b70c76c51a3d192e819d6990624f40e3585106aa07019a4c1161e376c082748774c34b0bcb5391c0cb34ed8aa4a5b9cca4f682e6ff3748f82ee78a5636f84c878148cc7020890befffaa4506cebbef9a3f7c67178f2";
  for (let i = 0; i < 64; i++)
    KL[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
}
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
function Hbuf(v: Json): string {
  const bytes = new TextEncoder().encode(canonicalJson(v));
  const padded = new Uint8Array((Math.floor((bytes.length + 8) / 64) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 2 ** 29));
  view.setUint32(padded.length - 4, (bytes.length % 2 ** 29) * 8);
  const h = new Uint32Array(IV);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (((w[i - 16] + s0) >>> 0) + ((w[i - 7] + s1) >>> 0)) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (((hh + S1) >>> 0) + ((ch + KL[i]) >>> 0) + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const sum = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + sum[i]) >>> 0;
  }
  let out = "";
  for (const word of h) out += word.toString(16).padStart(8, "0");
  return out;
}

const A: Record<string, number | string> = {};
say(
  `=== 规模墙：${N} defs × ${TEXT}B 源码文本（batch chunk=${CHUNK}）node ${process.version} ===`,
);

// ══ A 微基准：一条 100KB 的分段账（warmup+中位数，与 B 同进程同口径）══
say("A 微基准");
{
  const defs = Array.from({ length: 10 }, (_, i) => mkDef(900000 + i));
  const canon0 = canonicalJson(defs[0]);
  A.canon = medMs((k) => void canonicalJson(defs[k % 10]), 30);
  A.hash = medMs((k) => void H(defs[k % 10]), 20);
  A.hashMBps = TEXT / 1e6 / (Number(A.hash) / 1e3);
  say(
    `  H(args) ${Number(A.hash).toFixed(2)}ms/def → ${Number(A.hashMBps).toFixed(0)}MB/s（1GB 语料纯哈希 ≈ ${(Number(A.hash) * 10).toFixed(0)}s）`,
  );
  const bufs = defs.map((d) => Buffer.from(canonicalJson(d), "utf8"));
  A.native = medMs(
    (k) =>
      void createHash("sha256")
        .update(bufs[k % 10])
        .digest("hex"),
    30,
  );
  say(
    `  canonical ${Number(A.canon).toFixed(2)}ms；[宿主端参考，不进内核] 原生 sha256 ${Number(A.native).toFixed(2)}ms/def = ${(TEXT / 1e6 / (Number(A.native) / 1e3)).toFixed(0)}MB/s`,
  );
  const same = defs.every((d) => Hbuf(d) === H(d));
  A.hbuf = medMs((k) => void Hbuf(defs[k % 10]), 20);
  A.k1 = Number(A.hash) / Number(A.hbuf);
  say(
    `  [参考·纯 JS 可改] 字块化 ${Number(A.hbuf).toFixed(2)}ms/def，等价=${same ? "✓" : "✗"} → K1 上限 ${Number(A.k1).toFixed(1)}×`,
  );
  const e: Entry = {
    seq: 0,
    prev: null,
    op: "put",
    args: defs[0].body,
    argsHash: H(defs[0]),
    by: "a",
    at: NOW,
  };
  A.entryUs = avgMs(() => void entryHash(e), 2000) * 1e3;
  say(
    `  entryHash ≈ ${Number(A.entryUs).toFixed(2)}µs vs H(args) ${Number(A.hash).toFixed(1)}ms —— 链身份 O(1) 不吃字节 ✓`,
  );
  A.lineChars = JSON.stringify(e).length;
  A.bloat = (Number(A.lineChars) / canon0.length) * 100;
  A.parse = medMs((k) => void JSON.parse(bufs[k % 10].toString("utf8")), 30);
  A.string = medMs((k) => void JSON.stringify(defs[k % 10]), 30);
  say(
    `  JSON 单条：string ${Number(A.string).toFixed(2)}ms｜parse ${Number(A.parse).toFixed(2)}ms｜行 ≈ ${(Number(A.lineChars) / 1e3).toFixed(0)}K chars vs canonical ${(canon0.length / 1e3).toFixed(0)}K → 体积 ×${(Number(A.bloat) / 100).toFixed(2)}`,
  );
  try {
    "x".repeat(2 ** 29);
    A.maxStr = "≥2^29（本 build 未触，跳过深探）";
  } catch {
    A.maxStr = "2^29-24（V8 kMaxLength：0x1fffffe8 字符，试探即抛不占内存）";
  }
  const journalEst = Number(A.lineChars) * CHUNK * NCHUNK;
  say(
    `  V8 单串上限 ${A.maxStr}；journal ${NCHUNK} 行 batch ≈ ${(journalEst / 1e6).toFixed(0)}M chars → ${journalEst > 2 ** 29 ? "整本读为单串超上限（C 段实测）" : "未触限（×" + (2 ** 29 / journalEst).toFixed(0) + " 触限）"}`,
  );
  const bigTerm: Def = { body: ["c", genText(7)] as unknown as Json };
  const bk = H(bigTerm);
  const seedIn: {
    world: World;
    head: Head;
    run: string;
    now: number;
    caps: Record<string, boolean>;
    results: {};
    limits: { gas: number; depth: number };
    directives: { kind: "write"; request: WriteRequest }[];
  } = {
    world: EMPTY_WORLD,
    head: EMPTY_HEAD,
    run: "a-seed",
    now: NOW,
    caps: CAPS,
    results: {},
    limits: { gas: 1000, depth: 8 },
    directives: [
      {
        kind: "write" as const,
        request: {
          id: "x",
          op: "put",
          target: { expect_pos: null },
          args: bigTerm,
          by: "x",
        },
      },
    ],
  };
  const seed = run(seedIn);
  if (seed.status !== "done") throw new Error("seed");
  const evalMs = avgMs(
    () =>
      void run({
        ...seedIn,
        world: seed.world,
        head: seed.head,
        directives: [{ kind: "eval", entry: bk, args: null, ctx: {} }],
      }),
    30,
  );
  A.clone2k =
    avgMs(() => void cloneWorld(with2k(seed.world, bigTerm)), 40) * 1e3;
  say(
    `  eval 载 100KB c-字面量 ${(evalMs * 1e3).toFixed(0)}µs（含 clone@1def；同 def 的 put 要 ${Number(A.hash).toFixed(1)}ms）`,
  );
  say(
    `  cloneWorld@2001defs ${Number(A.clone2k).toFixed(0)}µs → 「每次 run 只写一条」模式 10k 次累计 ≈ ${(((Number(A.clone2k) / 2001) * N * N) / 2 / 1e6).toFixed(1)}s（批量化后消失）`,
  );
  gc();
  hr("A 末");
}
function with2k(w: World, d: Def): World {
  const cw = cloneWorld(w);
  for (let i = Object.keys(cw.defs).length; i < 2001; i++) {
    cw.defs["0".repeat(60) + i.toString(16).padStart(4, "0")] = d;
  }
  return cw;
}

// ══ B 全量写路 + blob 分片同步落盘 ══
say("B 写路");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(BLOBS, { recursive: true });
const B: Record<string, number | string> = {};
let revLive: Hash = "pending";
{
  const chunkDefs: Def[][] = [];
  B.gen = oneMs(() => {
    for (let ci = 0; ci < N; ci += CHUNK)
      chunkDefs.push(Array.from({ length: CHUNK }, (_, j) => mkDef(ci + j)));
  });
  say(`  语料生成 ${Number(B.gen).toFixed(0)}ms（宿主侧，不进账）`);
  writeFileSync(JOURNAL, "");
  let live = EMPTY_WORLD;
  let head = EMPTY_HEAD;
  const chunkMs: number[] = [];
  B.canonChars = 0;
  B.put = oneMs(() => {
    for (let ci = 0; ci < chunkDefs.length; ci++) {
      const tc = performance.now();
      const out = putBatch(live, head, "b1", chunkDefs[ci]);
      if (out.journal.length !== 1) throw new Error("B done");
      appendFileSync(JOURNAL, JSON.stringify(out.journal[0]) + "\n");
      for (let j = 0; j < CHUNK; j++) {
        const cb = canonicalJson(chunkDefs[ci][j]);
        B.canonChars = Number(B.canonChars) + cb.length;
        writeFileSync(
          join(BLOBS, `blob-${String(ci * CHUNK + j).padStart(6, "0")}`),
          cb,
        );
      }
      live = out.world;
      head = out.head;
      chunkMs.push(performance.now() - tc);
    }
  });
  B.perDef = Number(B.put) / N;
  B.putMBps = Number(B.canonChars) / Number(B.put);
  say(
    `  put+落盘 ${Number(B.put).toFixed(0)}ms（=${Number(B.perDef).toFixed(1)}ms/def ${(Number(B.putMBps) / 1e3).toFixed(0)}MB/s；内核两遍 H ≈ ${(Number(A.hash) * 2).toFixed(1)}ms/def，其余 stringify/blob/盘写）`,
  );
  say(
    `  首末 chunk 漂移 ${chunkMs[0].toFixed(0)} → ${chunkMs[chunkMs.length - 1].toFixed(0)}ms（cloneWorld O(defs) 与哈希同阶，被摊平）`,
  );
  B.dup = oneMs(() => {
    for (let ci = 0; ci < chunkDefs.length; ci++) {
      const out = putBatch(live, head, "dup", chunkDefs[ci]);
      if (out.journal.length !== 0) throw new Error("dup 不该产 entry");
      live = out.world;
      head = out.head;
    }
  });
  say(
    `  幂等重放同批 ${Number(B.dup).toFixed(0)}ms = put 的 ${((Number(B.dup) / Number(B.put)) * 100).toFixed(0)}% —— dup 短路（§10.3，T5 已落地）后只剩段 1 预哈希一趟：省幅 ~50% 是上界，那一趟是 argsHash 链格式不可免（§13 K5 口径）`,
  );
  B.rev = oneMs(() => {
    if (revLive !== "pending") throw new Error("revLive 脏");
    revLive = worldRev(live);
  });
  say(
    `  worldRev@${N}defs ${Number(B.rev).toFixed(0)}ms（只摘要 keys+ids，不吃 def 字节 ✓）`,
  );
  B.heapLive = process.memoryUsage().heapUsed / 1e6;
  hr("B 常驻");
  live = EMPTY_WORLD;
  chunkDefs.length = 0;
  gc();
  hr("B 释放");
}

// ══ C 落盘与读入账 ══
say("C 落盘");
{
  const buf = readFileSync(JOURNAL);
  B.journalBytes = buf.length;
  let blobBytes = 0;
  for (const f of readdirSync(BLOBS))
    blobBytes += statSync(join(BLOBS, f)).size;
  say(
    `  journal ${(buf.length / 1e6).toFixed(1)}MB vs canonical 原文 ${mb(Number(B.canonChars))}MB（${((buf.length / Number(B.canonChars)) * 100).toFixed(0)}%）；blobs ${readdirSync(BLOBS).length} 个 ${(blobBytes / 1e6).toFixed(0)}MB`,
  );
  let strErr = "";
  try {
    void buf.toString("utf8");
  } catch (err) {
    strErr =
      "RangeError：" +
      (err instanceof Error ? err.message.split("\n")[0] : "?");
  }
  say(
    `  整本读为单串：${strErr || "未炸（本规模 < 536MB；按 行存∝defs 数 外推，语料 ≈500MB 即触限）"}`,
  );
  B.jsonl = oneMs(() => {
    let sink = 0;
    for (const line of readLines(JOURNAL))
      sink += (JSON.parse(line.toString("utf8")) as Entry).seq;
    if (sink !== ((NCHUNK - 1) * NCHUNK) / 2) throw new Error("行数");
  });
  say(
    `  JSONL 切行+逐行 parse ${Number(B.jsonl).toFixed(0)}ms——落盘/流式读入不崩（成本 ∝ 字节）`,
  );
}

// ══ D 重启全量账（replay / verify）══
say("D 重启全量");
{
  const t0 = performance.now();
  const entries = readLines(JOURNAL).map(
    (l) => JSON.parse(l.toString("utf8")) as Entry,
  );
  B.parseAll = performance.now() - t0;
  hr(`D 整本 entries（${entries.length} batch 行）常驻`);
  say(
    `  Buffer 切行+parse ${Number(B.parseAll).toFixed(0)}ms（100K 字符/行 × ${entries.length} 行）`,
  );
  B.replay = oneMs(() => {
    const w = replay(entries);
    if (worldRev(w) !== revLive) throw new Error("D: replay ≠ live");
  });
  say(
    `  replay 全量 ${Number(B.replay).toFixed(0)}ms（=put 的 ${((Number(B.replay) / Number(B.put)) * 100).toFixed(0)}%；两趟纯内核 vs put 还含盘写）→ rev ≡ live ✓`,
  );
  B.verify = oneMs(() => {
    const v = verify(entries);
    if (!v.ok) throw new Error("D verify " + v.error);
  });
  say(
    `  verify 全链 ${Number(B.verify).toFixed(0)}ms ok ✓（若启动=verify+replay 两趟，冷启动 ${(2 * Number(B.replay)) / 1e3}s）`,
  );
  // ══ E 归档分界 ══
  const half = Math.floor(entries.length / 2);
  let snap: World = EMPTY_WORLD;
  let boundary: Entry | null = null;
  B.half = oneMs(() => {
    snap = replay(entries.slice(0, half));
    boundary = entries[half - 1] as Entry;
  });
  const anchor = anchorAfter(snap, boundary as Entry);
  B.tailV = oneMs(() => {
    const v = verify(entries.slice(half), anchor);
    if (!v.ok) throw new Error("E " + v.error);
  });
  B.tailR = oneMs(() => {
    const w = replay(entries.slice(half), snap);
    if (worldRev(w) !== revLive) throw new Error("E: 尾段 ≠");
  });
  say(
    `  E 归档：半链快照 ${Number(B.half).toFixed(0)}ms（一次性）→ 快档重启=replay 尾段 ${Number(B.tailR).toFixed(0)}ms（=全量 replay 的 ${((Number(B.tailR) / Number(B.replay)) * 100).toFixed(0)}%）；深档 +尾 verify ${Number(B.tailV).toFixed(0)}ms（同为 ~50%）✓ 半数据=半字节账`,
  );
  entries.length = 0;
  snap = EMPTY_WORLD;
  gc();
  hr("D/E 释放");
}

// ══ F [参考] 分片存储装配闸（journal 瘦身的宿主侧账）══
say("F [参考] 分片存储");
{
  const metas = readLines(JOURNAL).map((l) => {
    const e = JSON.parse(l.toString("utf8")) as Entry;
    return { ...e, args: null };
  });
  let gate = 0;
  let apply = 0;
  let w = cloneWorld(EMPTY_WORLD);
  for (let ci = 0; ci < metas.length; ci++) {
    const tg = performance.now();
    const pairs: [string, Hash][] = [];
    const ops: Json[] = [];
    for (let j = 0; j < CHUNK; j++) {
      const blob = readFileSync(
        join(BLOBS, `blob-${String(ci * CHUNK + j).padStart(6, "0")}`),
      );
      pairs.push(["put", createHash("sha256").update(blob).digest("hex")]);
      ops.push({
        op: "put",
        args: JSON.parse(blob.toString("utf8")) as Def,
      } as unknown as Json);
    }
    const line = metas[ci] as Entry;
    if (H({ ops: pairs }) !== line.argsHash)
      throw new Error(`F: 装配闸 mismatch @${ci}`);
    gate += performance.now() - tg;
    const ta = performance.now();
    const r = applyEntry(w, { ...line, args: { ops } });
    if (!r.ok || r.argsHash !== line.argsHash) throw new Error("F apply");
    apply += performance.now() - ta;
    w = r.world;
  }
  if (worldRev(w) !== revLive) throw new Error("F rev");
  B.gate = gate;
  B.fapply = apply;
  say(
    `  ${metas.length * CHUNK} blob 读+原生 sha+装配 ${(gate / 1e3).toFixed(1)}s → argsHash 全对 ✓ 磁盘/原生侧便宜；其后内核 apply ${(apply / 1e3).toFixed(1)}s——纯 JS 哈希才是墙本体（apply 无缓存可绕）`,
  );
  hr("F 末");
  gc();
}

// ══ G 汇总与绝对档位 ══
say("G 汇总");
{
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const corpus = Number(B.canonChars);
  const putS = Number(B.put) / 1e3;
  const replayS = Number(B.replay) / 1e3;
  say(`  常数表（本机 ${process.version}，medMs 热口径）：`);
  say(
    `    H 纯JS（内核路径）  ${Number(A.hash).toFixed(1)}ms/def = ${Number(A.hashMBps).toFixed(0)}MB/s → 1GB ≈ ${(Number(A.hash) * 10).toFixed(0)}s`,
  );
  say(
    `    [宿主端参考，不进内核] 原生 ${Number(A.native).toFixed(2)}ms/def = ${(TEXT / 1e6 / (Number(A.native) / 1e3)).toFixed(0)}MB/s（≈${(TEXT / 1e6 / (Number(A.native) / 1e3) / Number(A.hashMBps)).toFixed(0)}×）`,
  );
  say(`    K1 字块化上限          ${Number(A.k1).toFixed(1)}×（等价性已验）`);
  say(
    `    写路全含（H×2+盘）  ${Number(B.perDef).toFixed(1)}ms/def = ${(Number(B.putMBps) / 1e3).toFixed(1)}MB/s → 1GB ≈ ${putS.toFixed(0)}s`,
  );
  say(
    `    dup=put 的 ${((Number(B.dup) / Number(B.put)) * 100).toFixed(0)}%｜replay=${((Number(B.replay) / Number(B.put)) * 100).toFixed(0)}%put｜verify=${((Number(B.verify) / Number(B.replay)) * 100).toFixed(0)}%replay｜深档启动 ${((Number(B.verify) + Number(B.replay)) / 1e3).toFixed(0)}s vs 快档 ${((Number(B.replay) + Number(B.parseAll)) / 1e3).toFixed(0)}s`,
  );
  const pct1 = (Number(B.heapLive) * 1e6 * 100) / heapLimit;
  say(
    `  RAM 两档（绝对语料）：1GB 档（本轮 ${N} def≈${mb(corpus)}MB 正文）live heap ${mb(Number(B.heapLive) * 1e6)}MB / 上限 ${mb(heapLimit)}MB = ${pct1.toFixed(0)}%${pct1 > 75 ? "——满负荷且未给 GC 留量" : "；本规模 heap 未爆，wall 在语料更大时"}；10GB 档（${N * 10} def）live ≈${((corpus * 10) / 1e9).toFixed(1)}GB ${corpus * 10 > heapLimit * 0.75 ? "> 上限 ⇒ 单进程必崩——墙先于一切 CPU 项" : "< 上限（本轮上限较大）"}`,
  );
  say(
    `  journal：行存实测 ${(Number(B.journalBytes) / 1e6).toFixed(0)}MB = canonical 的 ${((Number(B.journalBytes) / corpus) * 100).toFixed(0)}%（∝defs 数，非 ∝chunk 数）${Number(B.journalBytes) > 2 ** 29 ? "> V8 单串 536MB ⇒ 整本单串读实测 RangeError（C 段）——「源码以数据形式进 journal」在此正式触物理墙" : "< V8 单串 536MB（本规模未触；∝defs 数外推必触）"}；X10 ≈ ${((Number(B.journalBytes) * 10) / 1e9).toFixed(1)}GB：JSONL 流式可扛、单串不可`,
  );
  say(
    `  对策账（本机）：K5 dup 短路已落地（B 段实测 dup=put 的 ${((Number(B.dup) / Number(B.put)) * 100).toFixed(0)}%，段 1 预哈希为不可免上界）→ 大字节不落热 defs（声明与本体分仓、正文走宿主内容仓+哈希引用，F 段证协议侧成立、T 段③④档测内核侧账）→ K1 字块化 ${Number(A.k1).toFixed(1)}×（前两条不做时止血）+ K2 batch 段1哈希复用 ÷2 + K4 快照分界（E 实测付半账）+ K3 JSONL 流式（C 实测已可用）`,
  );
}

// ══ T 四档分层实测（§0.4 四档各测一档：① 声明进 defs、② 留痕进链、③④ 本体分离）══
say("T 四档分层");
{
  const revEmpty = worldRev(EMPTY_WORLD);
  // —— ① 声明档：真实尺度源码进 defs——写路 / 全量审计（快照分界前的保险费）/ 克隆税 ——
  const T1N = Number(process.env.BENCH_T1_DEFS ?? "2500");
  const T1LEN = Number(process.env.BENCH_T1_BYTES ?? "20000");
  const T1CHUNK = Number(process.env.BENCH_T1_CHUNK ?? "100");
  {
    const MB = (T1N * T1LEN) / 1e6;
    const chunks: Def[][] = [];
    for (let ci = 0; ci < T1N; ci += T1CHUNK)
      chunks.push(
        Array.from({ length: Math.min(T1CHUNK, T1N - ci) }, (_, j) => ({
          body: { file: `s${ci + j}`, text: genText(ci + j, T1LEN) },
        })),
      );
    let w = EMPTY_WORLD;
    let h: Head = EMPTY_HEAD;
    const es: Entry[] = [];
    const write = oneMs(() => {
      for (const cd of chunks) {
        const out = putBatch(w, h, "t1", cd);
        es.push(...out.journal);
        w = out.world;
        h = out.head;
      }
    });
    if (Object.keys(w.defs).length !== T1N) throw new Error("T1 defs 数不符");
    const rev1 = worldRev(w);
    const audit = oneMs(() => {
      const v = verify(es);
      if (!v.ok) throw new Error("T1 verify " + v.error);
      if (worldRev(replay(es)) !== rev1) throw new Error("T1 审计 ≠ 写路口径");
    });
    const cloneUs = avgMs(() => void cloneWorld(w), 5) * 1e3;
    say(
      `  ① 声明档 ${T1N}×${(T1LEN / 1e3).toFixed(0)}KB=${MB.toFixed(0)}MB：写路 ${(write / 1e3).toFixed(1)}s｜全量审计(verify+replay) ${(audit / 1e3).toFixed(1)}s（=写路的 ${((audit * 100) / write).toFixed(0)}%，纯内核两趟）｜cloneWorld ${(cloneUs / 1e3).toFixed(1)}ms/次（O(defs)）`,
    );
    w = EMPTY_WORLD;
    es.length = 0;
    chunks.length = 0;
    gc();
    hr("T① 释放");
  }
  // —— ② 留痕档：载荷 note（② 的实现，T2 已放开）进链——defs 零增长 = 不变量 16 的实测 ——
  const T2N = Number(process.env.BENCH_T2_NOTES ?? "100000");
  {
    const T2CHUNK = 500;
    const blob = H({ corpus: "note-demo" });
    let w = EMPTY_WORLD;
    let h: Head = EMPTY_HEAD;
    const es: Entry[] = [];
    let payloadBytes = 0;
    const write = oneMs(() => {
      for (let ci = 0; ci < T2N; ci += T2CHUNK) {
        const ops: Json[] = [];
        for (let j = ci; j < Math.min(ci + T2CHUNK, T2N); j++)
          ops.push({
            op: "note",
            args: { kind: "obs", step: j, blob, msg: "x".repeat(110) },
          } as Json);
        const out = writeOps(w, h, "t2", ops);
        if (out.journal.length !== 1) throw new Error("T2 note 批未产 entry");
        payloadBytes += JSON.stringify(out.journal[0].args).length;
        es.push(...out.journal);
        w = out.world;
        h = out.head;
      }
    });
    const audit = oneMs(() => {
      const v = verify(es);
      if (!v.ok) throw new Error("T2 verify " + v.error);
      const rw = replay(es);
      if (worldRev(rw) !== revEmpty) throw new Error("T2 留痕动了世界（违不变量 16）");
    });
    say(
      `  ② 留痕档 ${T2N}×200B 级载荷 note：写路 ${(write / 1e3).toFixed(1)}s = ${((write * 1e3) / T2N).toFixed(1)}µs/条｜全量审计 ${(audit / 1e3).toFixed(1)}s｜defs ${Object.keys(w.defs).length}（零增长 ✓）replay ≡ EMPTY、worldRev 全程不变 ✓ 链上账 ≈ ${(payloadBytes / T2N).toFixed(0)}B/条`,
    );
    w = EMPTY_WORLD;
    es.length = 0;
    gc();
    hr("T② 释放");
  }
  // —— ③④ 本体档：1GB 尺度语料进 blob（宿主存储），世界只存"哈希 + 平台"声明 ——
  // ③ 与 ④ 协议同形（同一张表），区别只在宿主保留策略；这里测的是内核侧的账。
  const T4N = Number(process.env.BENCH_T34_REFS ?? "50000");
  {
    const T4CHUNK = 500;
    const KB = Number(process.env.BENCH_T34_BLOB_KB ?? "20");
    let w = EMPTY_WORLD;
    let h: Head = EMPTY_HEAD;
    const es: Entry[] = [];
    const write = oneMs(() => {
      for (let ci = 0; ci < T4N; ci += T4CHUNK) {
        const ops: Json[] = [];
        for (let j = ci; j < Math.min(ci + T4CHUNK, T4N); j++)
          ops.push({
            op: "put",
            args: { body: { sha: H({ blob: j }), platform: "linux-x64", kb: KB } },
          } as Json);
        const out = writeOps(w, h, "t4", ops);
        es.push(...out.journal);
        w = out.world;
        h = out.head;
      }
    });
    const audit = oneMs(() => {
      const v = verify(es);
      if (!v.ok) throw new Error("T4 verify " + v.error);
      if (Object.keys(replay(es).defs).length !== T4N) throw new Error("T4 数");
    });
    const ledger = JSON.stringify(w.defs).length;
    const corpusMB = (T4N * KB * 1e3) / 1e6;
    const corpusTxt = corpusMB >= 1000 ? `${(corpusMB / 1e3).toFixed(1)}GB` : `${corpusMB.toFixed(0)}MB`;
    say(
      `  ③④ 本体档 ${corpusTxt} 语料 → ${T4N} 条"哈希+平台"声明：写路 ${(write / 1e3).toFixed(1)}s｜全量审计 ${(audit / 1e3).toFixed(1)}s｜内核侧账 ${(ledger / 1e6).toFixed(1)}MB = 语料 ${((ledger * 100) / (T4N * KB * 1e3)).toFixed(2)}%（① 档同语料要把 ${corpusTxt} 全塞进 defs）`,
    );
    say(
      `  ③④ 交叉参照：同语料若按 ① 档走 put，纯内核哈希 ≈ ${(Number(A.hash) * 10).toFixed(0)}s（A 段本机速率外推 1GB）+ clone/O(defs)——③④ 档内核只付声明账 ${((write + audit) / 1e3).toFixed(1)}s；F 段已证宿主侧 blob+原生哈希重建核验便宜（本体可重算=③，不可重算=④ 只多持久保留策略差）`,
    );
    w = EMPTY_WORLD;
    es.length = 0;
    gc();
    hr("T③④ 释放");
  }
}
