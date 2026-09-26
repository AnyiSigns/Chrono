// CLI 命令派发表：`Record<命令名, 处理器>` 是保留命令名的单一真源——
// `RESERVED` 由 `Object.keys(handlers)` 派生，派发与保留集由构造保证不可能漂移。
// 处理器只做参数解析与转发，不认识任何业务语义。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from '../client/index.ts'
import type { AuditFilter, Client } from '../client/index.ts'
import {
  hostPaths,
  resolveCallTimeoutMs,
  resolveCompactStrict,
  resolveStartWrapper,
  resolveWatch,
  runAssetGc,
  runBlobGc,
  runCompact,
  runMaterializedGc,
  runPack,
  runReplay,
  runSeed,
  runVerify,
  unseededIdentities,
} from '../host/index.ts'
import type { EntryOptions, PluginEntry } from '../host/index.ts'
import type { Directive, Json } from '../kernel/index.ts'

export interface CommandContext {
  root: string
  args: string[]
  options: EntryOptions
}

export type CommandHandler = (context: CommandContext) => Promise<void> | void

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_MAIN = resolve(HERE, '..', 'host', 'main.ts')

function parseJsonArg(arg: string | undefined): Json {
  if (arg === undefined) return null
  if (arg.startsWith('@'))
    return JSON.parse(readFileSync(resolve(process.cwd(), arg.slice(1)), 'utf8')) as Json
  return JSON.parse(arg) as Json
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function helpText(): string {
  return [
    '用法：boot <命令> [--root <路径>] [参数]',
    '',
    '宿主：',
    '  start [--call-timeout-ms <ms>] [--start-wrapper <cmd>] [--watch]',
    '                              起宿主（世界单写者，后台进程）；超时缺省读',
    '                              CHRONO_CALL_TIMEOUT_MS，再缺省 30000；',
    '                              包装器缺省读 CHRONO_START_WRAPPER，再缺省无；',
    '                              --watch 打开源码 watcher（缺省读 CHRONO_WATCH，默认关）',
    '  stop                        令宿主停机',
    '  status                      查看链头与已装载身份',
    '',
    '发起者：',
    '  run <directives-json|@文件>  提交 directives 跑一轮',
    '  commands                    列出插件声明的命令',
    '  audit [filter-json|@文件]    只读审计面（run / emitter / outcome / limit）',
    '  <命令名> [args-json]         按声明调用插件命令',
    '',
    '离线（宿主未运行）：',
    '  seed [包路径...]             入世（缺省读 state/plugins.json，批量）',
    '  pack <目录> --identity <id>  入世单个插件目录（手动 / 程序化）',
    '  verify                      全量校验 journal',
    '  replay                      全量重放并给出内容摘要',
    '  unseeded                    列出尚无数据世代的身份（首启预置默认 body 的判据；不取写锁）',
    '  compact [--strict]           压缩：追加快照 + 冷段归档 + 写基础世界（--strict 严格回收，',
    '                              缺省读 CHRONO_COMPACT_STRICT，默认保守）',
    '  assets gc                   回收资产区里世界无引用的字节',
    '  blobs gc                    回收源码 CAS 里世界全部世代无引用的字节',
    '  materialized gc             回收物化目录（每身份保留 active 代码世代 + 前 N 代）',
    '',
    '  help                        本说明',
  ].join('\n')
}

async function withClient<T>(root: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect({ root })
  try {
    return await fn(client)
  } finally {
    client.close()
  }
}

/** 本次子进程是否已退出 / 起进程失败；在 spawn 后立即挂监听，避免漏掉瞬时退出。 */
interface ChildOutcome {
  error: Error | null
  exit: { code: number | null; signal: NodeJS.Signals | null } | null
}

function watchChild(child: ChildProcess): ChildOutcome {
  const outcome: ChildOutcome = { error: null, exit: null }
  child.once('error', (err) => {
    outcome.error = err
  })
  child.once('exit', (code, signal) => {
    outcome.exit = { code, signal }
  })
  return outcome
}

/** 锁文件持有者 pid：所连宿主即本子进程的判据（协议面不含 pid）。 */
function lockHolderPid(root: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(hostPaths(root).lockFile, 'utf8')) as { pid?: unknown }
    return typeof parsed.pid === 'number' ? parsed.pid : null
  } catch {
    return null
  }
}

async function waitForHost(
  root: string,
  timeoutMs: number,
  child: ChildProcess,
  outcome: ChildOutcome,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (outcome.error !== null) throw outcome.error
    if (outcome.exit !== null) {
      // 子进程先退出（锁被旧宿主占用 / 启动即败）：不得连到旧宿主谎报本次成功
      throw new Error(
        `start_failed: host process exited before ready (code=${outcome.exit.code}, signal=${outcome.exit.signal})`,
      )
    }
    try {
      const client = await connect({ root, timeoutMs: 500 })
      client.close()
      if (lockHolderPid(root) === child.pid) return
    } catch {
      // 宿主尚未就绪：退避后重试，直到超时
    }
    if (Date.now() > deadline) throw new Error('start_timeout')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

async function startHostProcess(
  root: string,
  callTimeoutMs: number,
  startWrapper: string | undefined,
  watch: boolean,
): Promise<void> {
  const hostArgs = [HOST_MAIN, '--root', root, '--call-timeout-ms', String(callTimeoutMs)]
  if (startWrapper !== undefined) hostArgs.push('--start-wrapper', startWrapper)
  if (watch) hostArgs.push('--watch')
  const child = spawn(process.execPath, hostArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: root,
  })
  const outcome = watchChild(child)
  child.unref()
  await waitForHost(root, 10_000, child, outcome)
  print({
    ok: true,
    root,
    pid: child.pid,
    call_timeout_ms: callTimeoutMs,
    start_wrapper: startWrapper ?? null,
    watch,
  })
}

function seedEntries(args: string[]): PluginEntry[] | undefined {
  if (args.length === 0) return undefined
  return args.map((path) => ({ name: basename(path), path }))
}

/** `pack <目录> --identity <id>`：目录与身份名都必填，多余参数 / 未知 flag fail-closed。 */
function packArgs(args: string[]): { dir: string; identity: string } {
  let dir: string | undefined
  let identity: string | undefined
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--identity') {
      const next = i + 1 < args.length ? args[i + 1] : undefined
      if (next === undefined || next.startsWith('--')) throw new Error('missing_identity')
      identity = next
      i += 1
      continue
    }
    if (token.startsWith('--')) throw new Error(`unknown_flag: ${token}`)
    if (dir === undefined) dir = token
    else throw new Error(`unexpected_arg: ${token}`)
  }
  if (dir === undefined) throw new Error('missing_dir')
  if (identity === undefined) throw new Error('missing_identity')
  return { dir, identity }
}

/**
 * 命令派发表：键集即保留命令名集。新增 CLI 命令必须同时加入
 * `packages/host/common/framework-commands.ts` 的 `FRAMEWORK_COMMAND_NAMES`，否则测试红。
 */
export const handlers: Record<string, CommandHandler> = {
  start: async ({ root, options }) => {
    await startHostProcess(
      root,
      resolveCallTimeoutMs(options.callTimeout, process.env['CHRONO_CALL_TIMEOUT_MS']),
      resolveStartWrapper(options.startWrapper, process.env['CHRONO_START_WRAPPER']),
      resolveWatch(options.watch, process.env['CHRONO_WATCH']),
    )
  },
  stop: async ({ root }) => {
    await withClient(root, async (client) => {
      await client.stop()
      print({ ok: true })
    })
  },
  status: async ({ root }) => {
    await withClient(root, async (client) => print(await client.status()))
  },
  commands: async ({ root }) => {
    await withClient(root, async (client) => print(await client.commands()))
  },
  audit: async ({ root, args }) => {
    const filter = parseJsonArg(args[0])
    await withClient(root, async (client) =>
      print(await client.audit(filter === null ? undefined : (filter as unknown as AuditFilter))),
    )
  },
  run: async ({ root, args }) => {
    await withClient(root, async (client) => {
      const directives = parseJsonArg(args[0])
      if (!Array.isArray(directives)) throw new Error('run expects a directives array')
      print(await client.submit(directives as Directive[]))
    })
  },
  seed: ({ root, args }) => {
    const report = runSeed(root, seedEntries(args))
    print(report)
    if (!report.ok) process.exitCode = 1
  },
  pack: ({ root, args }) => {
    const { dir, identity } = packArgs(args)
    const report = runPack(root, dir, identity)
    print(report)
    if (!report.ok) process.exitCode = 1
  },
  verify: ({ root }) => {
    print(runVerify(root))
  },
  unseeded: ({ root }) => {
    print(unseededIdentities(root))
  },
  replay: ({ root }) => {
    print(runReplay(root))
  },
  compact: ({ root, args }) => {
    const strict = resolveCompactStrict(
      args.includes('--strict'),
      process.env['CHRONO_COMPACT_STRICT'],
    )
    print(runCompact(root, { strict }))
  },
  assets: ({ root, args }) => {
    if (args[0] !== 'gc') throw new Error(`unknown_command: assets ${args[0] ?? ''}`)
    print(runAssetGc(root))
  },
  blobs: ({ root, args }) => {
    if (args[0] !== 'gc') throw new Error(`unknown_command: blobs ${args[0] ?? ''}`)
    print(runBlobGc(root))
  },
  materialized: ({ root, args }) => {
    if (args[0] !== 'gc') throw new Error(`unknown_command: materialized ${args[0] ?? ''}`)
    print(runMaterializedGc(root))
  },
  help: () => {
    process.stdout.write(`${helpText()}\n`)
  },
}

/** 非保留命令：按声明调用插件命令。 */
export async function dispatchPluginCommand(
  root: string,
  command: string,
  args: string[],
): Promise<void> {
  await withClient(root, async (client) =>
    print(await client.command(command, parseJsonArg(args[0]))),
  )
}
