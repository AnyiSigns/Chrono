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

/** 服务脚本源文本：临时服务包复用 fixture 同一份 main.js，避免两份实现漂移。 */
export const FIXTURE_SERVICE_MAIN = readFileSync(
  fileURLToPath(new URL('../../../fixtures/plugins/toy-alpha/execute/main.js', import.meta.url)),
  'utf8',
)

export interface PackageSpec {
  identity: string
  implements?: string[]
  methods?: Record<string, string[]>
  pins?: Record<string, string>
  start?: string
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
  packageJson?: Record<string, unknown>
}

/**
 * 在临时 root 下写一个完整插件包（契约 12 字段齐全、CommonJS 信封）。
 * 返回包根绝对路径；同名身份重复调用会覆盖已有文件（换代测试用）。
 */
export function writeTempPackage(root: string, spec: PackageSpec): string {
  const pkgRoot = join(root, 'pkgs', spec.identity)
  const methods =
    spec.methods ?? Object.fromEntries(spec.implements?.map((cap) => [cap, ['echo']]) ?? [])
  const start = spec.start ?? ''
  const pluginJson = {
    identity: spec.identity,
    schema: 'schema/plugin.schema.json',
    implements: spec.implements ?? [],
    methods,
    pins: spec.pins ?? {},
    start,
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
  writeJson(
    pkgRoot,
    'schema/plugin.schema.json',
    spec.schema ?? {
      type: 'object',
      title: `${spec.identity} identity schema`,
    },
  )
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
