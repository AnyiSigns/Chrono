// CLI 薄壳（genesis 常量）：start 起宿主；其余命令连宿主或离线执行。
// 只做参数解析与转发，不认识任何业务语义。

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from '../client/index.ts'
import type { AuditFilter, Client } from '../client/index.ts'
import {
  parseEntryArgv,
  resolveCallTimeoutMs,
  resolveRoot,
  runAssetGc,
  runCompact,
  runReplay,
  runSeed,
  runVerify,
} from '../host/index.ts'
import type { PluginEntry } from '../host/index.ts'
import type { Directive, Json } from '../kernel/index.ts'

/** 宿主 / CLI 保留字：插件命令不得占用，CLI 亦不把它们当插件命令。 */
const RESERVED = new Set([
  'start',
  'stop',
  'run',
  'status',
  'seed',
  'verify',
  'replay',
  'compact',
  'commands',
  'audit',
  'assets',
  'help',
])

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

function helpText(): string {
  return [
    '用法：boot <命令> [--root <路径>] [参数]',
    '',
    '宿主：',
    '  start [--call-timeout-ms <ms>]',
    '                              起宿主（唯一写者，后台进程）；超时缺省读',
    '                              CHRONO_CALL_TIMEOUT_MS，再缺省 30000',
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
    '  seed [包路径...]             入世（缺省读 state/plugins.json）',
    '  verify                      全量校验 journal',
    '  replay                      全量重放并给出内容摘要',
    '  compact                     压缩：追加快照 + 冷段归档 + 写基础世界',
    '  assets gc                   回收资产区里世界无引用的字节',
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

async function waitForHost(root: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const client = await connect({ root, timeoutMs: 500 })
      client.close()
      return
    } catch {
      // 宿主尚未就绪：退避后重试，直到超时
    }
    if (Date.now() > deadline) throw new Error('start_timeout')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

async function startHostProcess(root: string, callTimeoutMs: number): Promise<void> {
  const child = spawn(
    process.execPath,
    [HOST_MAIN, '--root', root, '--call-timeout-ms', String(callTimeoutMs)],
    {
      detached: true,
      stdio: 'ignore',
      cwd: root,
    },
  )
  child.unref()
  await waitForHost(root, 10_000)
  print({ ok: true, root, pid: child.pid, call_timeout_ms: callTimeoutMs })
}

function seedEntries(args: string[]): PluginEntry[] | undefined {
  if (args.length === 0) return undefined
  return args.map((path) => ({ name: basename(path), path }))
}

async function main(): Promise<void> {
  const parsed = parseEntryArgv(process.argv.slice(2))
  const root = resolveRoot(parsed.root)
  const [command, ...args] = parsed.rest

  if (command === undefined || command === 'help') {
    process.stdout.write(`${helpText()}\n`)
    return
  }

  switch (command) {
    case 'start':
      await startHostProcess(
        root,
        resolveCallTimeoutMs(parsed.callTimeout, process.env['CHRONO_CALL_TIMEOUT_MS']),
      )
      return
    case 'stop':
      await withClient(root, async (client) => {
        await client.stop()
        print({ ok: true })
      })
      return
    case 'status':
      await withClient(root, async (client) => print(await client.status()))
      return
    case 'commands':
      await withClient(root, async (client) => print(await client.commands()))
      return
    case 'audit': {
      const filter = parseJsonArg(args[0])
      await withClient(root, async (client) =>
        print(await client.audit(filter === null ? undefined : (filter as unknown as AuditFilter))),
      )
      return
    }
    case 'run':
      await withClient(root, async (client) => {
        const directives = parseJsonArg(args[0])
        if (!Array.isArray(directives)) throw new Error('run expects a directives array')
        print(await client.submit(directives as Directive[]))
      })
      return
    case 'seed':
      print(runSeed(root, seedEntries(args)))
      return
    case 'verify':
      print(runVerify(root))
      return
    case 'replay':
      print(runReplay(root))
      return
    case 'compact':
      print(runCompact(root))
      return
    case 'assets': {
      if (args[0] !== 'gc') throw new Error(`unknown_command: assets ${args[0] ?? ''}`)
      print(runAssetGc(root))
      return
    }
    default:
      if (RESERVED.has(command)) throw new Error(`unknown_command: ${command}`)
      await withClient(root, async (client) =>
        print(await client.command(command, parseJsonArg(args[0]))),
      )
  }
}

try {
  await main()
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exitCode = 1
}
