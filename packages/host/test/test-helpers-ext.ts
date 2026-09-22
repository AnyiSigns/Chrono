// 测试辅助（扩展）：临时插件包生成、生命周期日志读取、有界轮询、进程树清理。
// 只允许被 packages/host/**/test/** 引用；不触碰实现与文档。

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commit } from '../../kernel/index.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

/** 仓库 fixtures/plugins 下两个 toy 插件的绝对路径（供 seed 进临时世界）。 */
export const FIXTURE_ALPHA = fileURLToPath(
  new URL('../../../fixtures/plugins/toy-alpha', import.meta.url),
)
export const FIXTURE_BETA = fileURLToPath(
  new URL('../../../fixtures/plugins/toy-beta', import.meta.url),
)
/** 非 JS（Python）toy 插件包：服务协议走 stdio，宿主不解释语言。 */
export const FIXTURE_PYTHON = fileURLToPath(
  new URL('../../../fixtures/plugins/toy-python', import.meta.url),
)

/** 服务脚本源文本：临时服务包复用 fixture 同一份 main.js，避免两份实现漂移。 */
export const FIXTURE_SERVICE_MAIN = readFileSync(
  fileURLToPath(new URL('../../../fixtures/plugins/toy-alpha/execute/main.js', import.meta.url)),
  'utf8',
)

/**
 * 反向调用夹具服务：配了 `reversePort` 时先发 `port.call` 到目标，再把
 * `{env, forwarded, argsEnv}` 回给宿主；否则回 `{env, args, pid}`。用于验证
 * 反向转发 / 端口审计 / 方法级超时；帧编解码与宿主同形。
 */
export const REVERSE_SERVICE_MAIN = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "service-config.json"), "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") process.stderr.write("[reverse-toy] bad service-config.json");
}
function plugin() {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "plugin.json"), "utf8"));
}
function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}
function argsEnvOf(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args.env === undefined ? null : args.env;
}
let seq = 0;
const pending = new Map();
function onCall(msg) {
  const env = msg.env === undefined ? null : msg.env;
  if (!config.reversePort) {
    frame({ v: "1", id: msg.id, kind: "result", ok: true, value: { env: env, args: msg.args === undefined ? null : msg.args, pid: process.pid } });
    return;
  }
  const id = "pc-" + (++seq);
  const args = config.reverseArgs === undefined ? (msg.args === undefined ? null : msg.args) : config.reverseArgs;
  pending.set(id, { callId: msg.id, env: env, argsEnv: argsEnvOf(msg.args) });
  frame({ v: "1", id: id, kind: "port.call", port: config.reversePort, method: config.reverseMethod || "echo", args: args });
}
function onPort(id, value) {
  const waiting = pending.get(id);
  if (waiting === undefined) return;
  pending.delete(id);
  frame({ v: "1", id: waiting.callId, kind: "result", ok: true, value: { env: waiting.env, forwarded: value, argsEnv: waiting.argsEnv } });
}
function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.kind) {
    case "hello": {
      const p = plugin();
      frame(Object.assign({ id: msg.id, kind: "manifest" }, { v: "1", identity: p.identity, implements: p.implements, methods: p.methods, protocol: p.protocol, state: p.state }));
      return;
    }
    case "probe": frame({ id: msg.id, kind: "pong", ok: true }); return;
    case "reload": frame({ v: "1", id: msg.id, kind: "ack" }); return;
    case "drain": frame({ v: "1", id: msg.id, kind: "bye" }); return;
    case "call": onCall(msg); return;
    case "port.result": onPort(msg.id, msg.value === undefined ? null : msg.value); return;
    case "port.error": onPort(msg.id, { error: msg.error === undefined ? null : msg.error }); return;
  }
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) break;
    const body = buffer.subarray(4, 4 + length).toString("utf8");
    buffer = buffer.subarray(4 + length);
    try { handle(JSON.parse(body)); } catch (err) { process.stderr.write("[reverse-toy] bad frame: " + err.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
`

export interface PackageSpec {
  identity: string
  /** 包目录名（缺省 = identity）；同一身份多版本并存时用它避免目录互相覆盖。 */
  dir?: string
  implements?: string[]
  methods?: Record<string, string[]>
  pins?: Record<string, string>
  start?: string
  /** 显式构建声明；省略则不写 `build` 字段（回落宿主旧探测）。 */
  build?: Array<{ cmd: string; args: string[] }>
  /** 独占资源声明；省略则不写 `exclusive` 字段（无独占资源）。 */
  exclusive?: string[]
  protocol?: string
  restart?: Record<string, unknown>
  health?: Record<string, unknown>
  state?: string
  members?: Array<{ kind: string; path: string }>
  commands?: Array<{ name: string; entry: string; argsSchema?: string }>
  serviceConfig?: Record<string, unknown>
  worldignore?: string[]
  files?: Record<string, string>
  terms?: Record<string, string>
  schema?: Record<string, unknown>
  /** 省略 `plugin.json.schema` 字段与包内 schema 文件（零 schema 插件）。 */
  omitSchema?: boolean
  packageJson?: Record<string, unknown>
}

/**
 * 在临时 root 下写一个完整插件包（契约 14 字段：`build` / `exclusive` 缺省省略、其余齐全；CommonJS 信封）。
 * 返回包根绝对路径；同名身份重复调用会覆盖已有文件（换代测试用）。
 */
export function writeTempPackage(root: string, spec: PackageSpec): string {
  const pkgRoot = join(root, 'pkgs', spec.dir ?? spec.identity)
  const methods =
    spec.methods ?? Object.fromEntries(spec.implements?.map((cap) => [cap, ['echo']]) ?? [])
  const start = spec.start ?? ''
  const pluginJson = {
    identity: spec.identity,
    ...(spec.omitSchema ? {} : { schema: 'schema/plugin.schema.json' }),
    implements: spec.implements ?? [],
    methods,
    pins: spec.pins ?? {},
    start,
    ...(spec.build === undefined ? {} : { build: spec.build }),
    ...(spec.exclusive === undefined ? {} : { exclusive: spec.exclusive }),
    protocol: spec.protocol ?? '1',
    restart: spec.restart ?? {
      policy: 'on-exit',
      backoff: 'none',
      max: 3,
      window_ms: 60000,
      drain_ms: 500,
    },
    health: spec.health ?? {
      probe: `${spec.identity}.echo`,
      interval_ms: 10000,
      timeout_ms: 1000,
    },
    state: spec.state ?? 'recomputable',
    members:
      spec.members ?? (start.trim().length > 0 ? [{ kind: 'execute', path: 'execute/' }] : []),
    commands: spec.commands ?? [],
  }
  writeJson(pkgRoot, 'plugin.json', pluginJson)
  writeJson(
    pkgRoot,
    'package.json',
    spec.packageJson ?? {
      name: spec.identity,
      version: '0.0.0',
      private: true,
    },
  )
  writeFile(join(pkgRoot, 'README.md'), `# ${spec.identity}\n`)
  if (!spec.omitSchema) {
    writeJson(
      pkgRoot,
      'schema/plugin.schema.json',
      spec.schema ?? {
        type: 'object',
        title: `${spec.identity} identity schema`,
      },
    )
  }
  if (start.trim().length > 0) {
    writeFile(join(pkgRoot, 'execute/main.js'), FIXTURE_SERVICE_MAIN)
  }
  if (spec.serviceConfig !== undefined) {
    writeJson(pkgRoot, 'service-config.json', spec.serviceConfig)
  }
  if (spec.worldignore !== undefined) {
    writeFile(join(pkgRoot, '.worldignore'), spec.worldignore.join('\n') + '\n')
  }
  if (spec.terms !== undefined) {
    for (const [name, body] of Object.entries(spec.terms)) {
      writeFile(join(pkgRoot, 'terms', name), body)
    }
  }
  if (spec.files !== undefined) {
    for (const [rel, content] of Object.entries(spec.files)) {
      writeFile(join(pkgRoot, rel), content)
    }
  }
  return pkgRoot
}

function writeJson(pkgRoot: string, rel: string, value: unknown): void {
  writeFile(join(pkgRoot, rel), JSON.stringify(value, null, 2))
}

function writeFile(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** 把一批 put 子操作提交进一个空世界（packSourceDir 排除验证用）。 */
export function applyBatchOps(world: World, ops: Json[]): void {
  const outcome = commit(
    { seq: -1, hash: null },
    world,
    {
      id: 'test-batch',
      op: 'batch',
      target: { expect_pos: null },
      args: { ops },
      by: 'test',
    },
    Date.now(),
  )
  if (!outcome.verdict.ok) {
    throw new Error(`batch rejected: ${outcome.verdict.reasons.join(',')}`)
  }
}

/** 从 tree def 递归收集文件路径（materialize / packSourceDir 验证用）。 */
export function collectTreePaths(world: World, treeHash: Hash): string[] {
  const out: string[] = []
  const walk = (hash: Hash, prefix: string): void => {
    const def = world.defs[hash]
    const entries = (def?.body as { entries?: Json } | undefined)?.entries
    if (!Array.isArray(entries)) throw new Error('bad_tree in test helper')
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const rec = entry as { [k: string]: Json }
      const name = rec['name']
      const mode = rec['mode']
      const child = rec['hash']
      if (typeof name !== 'string' || typeof mode !== 'string' || typeof child !== 'string')
        continue
      const p = prefix.length === 0 ? name : `${prefix}/${name}`
      if (mode === 'dir') walk(child, p)
      else out.push(p)
    }
  }
  walk(treeHash, '')
  return out.sort()
}

export interface LifeLogEntry {
  at: number
  kind: string
  event: string
  impl?: string
  gen?: string
  cap?: string
  reason?: string
  caps?: string[]
}

/** 运维日志：逐行解析规范 JSON（键序可能被排序，解析后再断言）。 */
export function readLifecycle(file: string): LifeLogEntry[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LifeLogEntry)
}

/** 有界轮询：predicate 为真即返回，超时抛错（不用长时间固定 sleep）。 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor 超时: ${label}`)
}

/** 等待 lifecycle.log 出现满足 predicate 的记录；返回最后一次读取。 */
export async function waitForLifecycle(
  file: string,
  predicate: (entry: LifeLogEntry) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<LifeLogEntry[]> {
  let latest: LifeLogEntry[] = []
  await waitFor(
    () => {
      latest = readLifecycle(file)
      return latest.some(predicate)
    },
    label,
    timeoutMs,
  )
  return latest
}

/**
 * 等待事件流静默：`get()` 返回的记录列表在 quietMs 内不再增长即返回。
 * 用于崩溃/健康重启测试在停机前等重启环落地，避免 in-flight 重启越过 stop()+清理
 * 在已清空的物化目录上再 spawn（Windows 上会打 MODULE_NOT_FOUND / start_failed 噪音）。
 */
export async function waitForQuiescence(
  get: () => unknown[],
  label: string,
  quietMs = 300,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = get().length
  let quiet = 0
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const count = get().length
    if (count === last) {
      quiet += 25
      if (quiet >= quietMs) return
    } else {
      last = count
      quiet = 0
    }
  }
  throw new Error(`waitForQuiescence 超时（事件流未静默）: ${label}`)
}

/** 进程存活检测：kill(pid, 0) 探针；EPERM 视为存活。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 杀掉服务进程树：Windows 上宿主以 shell 起服务，child.pid 是 cmd 包装进程，
 * 单杀 cmd 会遗留 node 子进程，故用 taskkill /T（杀整树）保证无孤儿。
 * 容忍「目标已死」：实现侧通道断开后的清理常与调用方抢同一棵树，
 * taskkill 对消失的目标会以 128 退出并打 ERROR —— 意图（树消失）已达成，不判失败。
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!isPidAlive(pid)) {
      resolve()
      return
    }
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => {
        // 退出码（0=已杀 / 128=已无运行实例）不区分：杀掉与已死等价
        resolve()
      })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // 进程组已不存在（已自然退出）同样视为达成
      }
      resolve()
    }
  })
}
