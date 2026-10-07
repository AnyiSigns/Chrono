// CLI 命令派发表：四域命名空间 `world` / `plugin` / `term` / `help`。
// 文法：`chrono <域> <世界路径/别名> <子命令> [参数]`——世界是唯一作用单位，
// 世界引用先按全局注册表别名解析、未命中再按文件路径；插件命令只能经 `plugin <世界> <命令>` 调用。
// 键集即顶层保留命令名集（`FRAMEWORK_COMMAND_NAMES`），由构造保证不可能漂移。
// 处理器只做参数解析与转发，不认识任何业务语义。

import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from '../client/index.ts'
import type { AuditFilter, Client } from '../client/index.ts'
import {
  hostPaths,
  inspectIdentity,
  listPlugins,
  listWorlds,
  registerPlugin,
  registerWorld,
  removePlugin,
  resolveCallTimeoutMs,
  resolveCompactStrict,
  resolveStartWrapper,
  resolveWatch,
  resolveWorldRef,
  runAssetGc,
  runBlobGc,
  runCompact,
  runMaterializedGc,
  runPack,
  runReplay,
  runRetire,
  runSeed,
  runSetActive,
  runVerify,
  stagePlugin,
  unregisterWorld,
  unseededIdentities,
} from '../host/index.ts'
import type { EntryOptions, PluginEntry, PluginGenView } from '../host/index.ts'
import type { Directive, Json } from '../kernel/index.ts'

export interface CommandContext {
  root: string
  args: string[]
  options: EntryOptions
}

export type CommandHandler = (context: CommandContext) => Promise<void> | void

const HERE = dirname(fileURLToPath(import.meta.url))
// 编译产物为 .js、源码直跑为 .ts：按本模块扩展名择宿主入口同名扩展，避免两处漂移。
const SELF_EXT = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
const HOST_MAIN = resolve(HERE, '..', 'host', `main.${SELF_EXT}`)

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
    '用法：chrono <域> <世界路径/别名> <子命令> [参数]',
    '',
    '世界（world）：',
    '  world ls                              列出已登记世界（别名 / 路径 / 运行状态）',
    '  world create <路径> as <别名>          初始化并登记新世界',
    '  world remove <世界>                    注销世界（不删文件）',
    '  world start <世界> | --all             起宿主（世界单写者，后台进程）',
    '  world stop  <世界> | --all             停宿主',
    '  world status <世界>                    查看链头与已装载身份',
    '  world run <世界> <directives|@文件>    提交 directives 跑一轮',
    '  world audit <世界> [filter|@文件]      只读审计面（run / emitter / outcome / limit）',
    '  world gc <世界> assets|blobs|materialized  回收无引用字节 / 目录',
    '  world seed <世界> [包路径...]          离线入世（缺省读 state/plugins.json 批量）',
    '  world pack <世界> <目录> --identity <id>  离线入世单个插件目录（手动 / 程序化）',
    '  world verify <世界>                    全量校验 journal',
    '  world replay <世界>                    全量重放并给出内容摘要',
    '  world unseeded <世界>                  列出尚无数据世代的身份（不取写锁）',
    '  world compact <世界> [--strict]        压缩（--strict 严格回收，缺省读 CHRONO_COMPACT_STRICT）',
    '',
    '插件（plugin）：',
    '  plugin <世界> ls                       列出已登记插件（名字 / 身份 / hot）',
    '  plugin <世界> add <本地路径|npm 包名|git 仓库> [--name <n>] [--ref <r>]',
    '  plugin <世界> upgrade <插件>           触发生成新代码世代',
    '  plugin <世界> remove <插件>            退役（撤下暂存 + 世界 retire）',
    '  plugin <世界> info <插件>              查看插件身份 / active 世代 / 可用世代 / hot',
    '  plugin <世界> switch <插件> <版本号>    切换 active 世代（版本号 = 世代号或 payload 哈希）',
    '  plugin <世界> commands                 列出插件声明的命令',
    '  plugin <世界> <命令名> [args-json]     按声明调用插件命令',
    '',
    '其它：',
    '  term build <目录>                      内置 toolchain 编译 terms.src/*.json → terms/*.json',
    '  help                                   本说明',
  ].join('\n')
}

async function withClient<T>(
  root: string,
  fn: (client: Client) => Promise<T>,
  runTimeoutMs?: number,
): Promise<T> {
  const client = await connect({ root, ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }) })
  try {
    return await fn(client)
  } finally {
    client.close()
  }
}

/**
 * run/等待超时：与宿主可配 `call-timeout` 同口径（CLI > `CHRONO_CALL_TIMEOUT_MS` > 30s 常量）。
 * 取舍：boot 连的是可能在别处启动的宿主，读不到其进程级生效值，故按本进程同一优先级解析并透传。
 */
function resolveRunTimeoutMs(options: EntryOptions): number {
  return resolveCallTimeoutMs(options.callTimeout, process.env['CHRONO_CALL_TIMEOUT_MS'])
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

/** 起宿主进程并等就绪；返回生效参数摘要（由调用方决定打印 / 汇总）。 */
interface StartedHost {
  ok: true
  root: string
  pid: number
  call_timeout_ms: number
  start_wrapper: string | null
  watch: boolean
}

async function startHostProcess(
  root: string,
  callTimeoutMs: number,
  startWrapper: string | undefined,
  watch: boolean,
): Promise<StartedHost> {
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
  return {
    ok: true,
    root,
    pid: child.pid ?? 0,
    call_timeout_ms: callTimeoutMs,
    start_wrapper: startWrapper ?? null,
    watch,
  }
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

/** 连接运行中的宿主；未起（socket 不通）返回 null，交由调用方走离线路径。 */
async function tryConnect(root: string): Promise<Client | null> {
  try {
    return await connect({ root, timeoutMs: 400, runTimeoutMs: 120_000 })
  } catch {
    return null
  }
}

/** `add <source> [--name <n>] [--ref <r>]`：位置参数恰一个，未知 flag fail-closed。 */
function parseAddArgs(args: string[]): { source: string; name?: string; ref?: string } {
  const positional: string[] = []
  let name: string | undefined
  let ref: string | undefined
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--name' || token === '--ref') {
      const value = i + 1 < args.length ? args[i + 1] : undefined
      if (value === undefined || value.startsWith('--')) throw new Error(`missing_value: ${token}`)
      if (token === '--name') name = value
      else ref = value
      i += 1
      continue
    }
    if (token.startsWith('--')) throw new Error(`unknown_flag: ${token}`)
    positional.push(token)
  }
  if (positional.length !== 1) throw new Error('add expects <来源>')
  return {
    source: positional[0],
    ...(name === undefined ? {} : { name }),
    ...(ref === undefined ? {} : { ref }),
  }
}

// ── world 域 ──────────────────────────────────────────────

/** 从位置参数取世界引用并解析为根；缺参 / flag 位 fail-closed。 */
function worldRoot(args: string[], index = 0): { root: string; rest: string[] } {
  const ref = args[index]
  if (ref === undefined || ref.startsWith('--')) throw new Error('missing_world')
  return { root: resolveWorldRef(ref), rest: args.slice(index + 1) }
}

async function worldLs(): Promise<void> {
  const worlds = []
  for (const entry of listWorlds()) {
    const client = await tryConnect(entry.root)
    const running = client !== null
    if (client !== null) client.close()
    worlds.push({ alias: entry.alias, root: entry.root, running })
  }
  print({ worlds })
}

function worldCreate(args: string[]): void {
  const path = args[0]
  if (path === undefined || path.startsWith('--') || args[1] !== 'as') {
    throw new Error('create expects <路径> as <别名>')
  }
  const alias = args[2]
  if (alias === undefined || alias.startsWith('--')) {
    throw new Error('create expects <路径> as <别名>')
  }
  if (args.length > 3) throw new Error(`unexpected_arg: ${args[3]}`)
  const root = resolve(process.cwd(), path)
  mkdirSync(root, { recursive: true })
  const entry = registerWorld(alias, root)
  print({ ok: true, alias: entry.alias, root: entry.root })
}

async function startRegisteredWorld(
  alias: string,
  root: string,
  callTimeoutMs: number,
  startWrapper: string | undefined,
  watch: boolean,
): Promise<Record<string, Json>> {
  const existing = await tryConnect(root)
  if (existing !== null) {
    existing.close()
    return { alias, root, ok: true, status: 'already_running' }
  }
  try {
    const started = await startHostProcess(root, callTimeoutMs, startWrapper, watch)
    return { alias, root, ok: true, status: 'started', pid: started.pid }
  } catch (err) {
    return { alias, root, ok: false, status: 'failed', error: (err as Error).message }
  }
}

async function worldStart(args: string[], options: EntryOptions): Promise<void> {
  const callTimeoutMs = resolveCallTimeoutMs(
    options.callTimeout,
    process.env['CHRONO_CALL_TIMEOUT_MS'],
  )
  const startWrapper = resolveStartWrapper(
    options.startWrapper,
    process.env['CHRONO_START_WRAPPER'],
  )
  const watch = resolveWatch(options.watch, process.env['CHRONO_WATCH'])
  if (args.includes('--all')) {
    const worlds = []
    for (const entry of listWorlds()) {
      worlds.push(
        await startRegisteredWorld(entry.alias, entry.root, callTimeoutMs, startWrapper, watch),
      )
    }
    const ok = worlds.every((item) => item['ok'] === true)
    print({ ok, worlds })
    if (!ok) process.exitCode = 1
    return
  }
  const ref = args[0]
  if (ref === undefined || ref.startsWith('--')) throw new Error('missing_world')
  const started = await startHostProcess(resolveWorldRef(ref), callTimeoutMs, startWrapper, watch)
  print(started)
}

async function stopRegisteredWorld(alias: string, root: string): Promise<Record<string, Json>> {
  const client = await tryConnect(root)
  if (client === null) return { alias, root, ok: true, status: 'not_running' }
  try {
    await client.stop()
    return { alias, root, ok: true, status: 'stopped' }
  } catch (err) {
    return { alias, root, ok: false, status: 'failed', error: (err as Error).message }
  } finally {
    client.close()
  }
}

async function worldStop(args: string[]): Promise<void> {
  if (args.includes('--all')) {
    const worlds = []
    for (const entry of listWorlds()) {
      worlds.push(await stopRegisteredWorld(entry.alias, entry.root))
    }
    const ok = worlds.every((item) => item['ok'] === true)
    print({ ok, worlds })
    if (!ok) process.exitCode = 1
    return
  }
  const ref = args[0]
  if (ref === undefined || ref.startsWith('--')) throw new Error('missing_world')
  const root = resolveWorldRef(ref)
  await withClient(root, async (client) => {
    await client.stop()
    print({ ok: true, world: ref, root })
  })
}

function gcWorld(root: string, kind: string | undefined): void {
  switch (kind) {
    case 'assets':
      print(runAssetGc(root))
      return
    case 'blobs':
      print(runBlobGc(root))
      return
    case 'materialized':
      print(runMaterializedGc(root))
      return
    default:
      throw new Error(`unknown_command: world gc ${kind ?? ''}（应为 assets|blobs|materialized）`)
  }
}

// ── plugin 域 ─────────────────────────────────────────────

function pluginName(sub: string, raw: string | undefined): string {
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${sub} expects <插件>`)
  return raw
}

async function pluginAdd(root: string, args: string[]): Promise<void> {
  const { source, name, ref } = parseAddArgs(args)
  const staged = stagePlugin(root, source, process.cwd(), {
    ...(name === undefined ? {} : { name }),
    ...(ref === undefined ? {} : { ref }),
  })
  registerPlugin(root, { name: staged.name, path: `plugins/${staged.name}` })
  const client = await tryConnect(root)
  let host: string
  if (client !== null) {
    try {
      host = (await client.ingestPlugin(staged.name)).status
    } finally {
      client.close()
    }
  } else {
    const report = runSeed(root, [{ name: staged.name, path: `plugins/${staged.name}` }])
    if (!report.ok) {
      print({ ok: false, name: staged.name, seeded: report })
      process.exitCode = 1
      return
    }
    // 离线 seed 无 client：host 取该项真实状态（seeded / unchanged），不得写死 'seeded'
    host = report.items.find((item) => item.name === staged.name)?.status ?? 'seeded'
  }
  print({
    ok: true,
    name: staged.name,
    identity: staged.identity,
    kind: staged.kind,
    hot: staged.hot,
    host,
  })
}

async function pluginUpgrade(root: string, nameRaw: string | undefined): Promise<void> {
  const name = pluginName('upgrade', nameRaw)
  const client = await tryConnect(root)
  if (client !== null) {
    try {
      print({ ok: true, ...(await client.ingestPlugin(name)) })
    } finally {
      client.close()
    }
    return
  }
  const report = runSeed(root, [{ name, path: `plugins/${name}` }])
  print(report)
  if (!report.ok) process.exitCode = 1
}

async function pluginRemove(root: string, nameRaw: string | undefined): Promise<void> {
  const name = pluginName('remove', nameRaw)
  const client = await tryConnect(root)
  let host: string
  if (client !== null) {
    try {
      host = (await client.removePlugin(name)).status
    } finally {
      client.close()
    }
  } else {
    const installed = listPlugins(root).find((plugin) => plugin.name === name)
    host = runRetire(root, installed?.identity ?? name).status
  }
  const removed = removePlugin(root, name)
  print({ ok: removed.ok, name, host, archived_to: removed.archivedTo, reasons: removed.reasons })
  if (!removed.ok) process.exitCode = 1
}

async function pluginInfo(root: string, nameRaw: string | undefined): Promise<void> {
  const name = pluginName('info', nameRaw)
  const entry = listPlugins(root).find((plugin) => plugin.name === name)
  if (entry === undefined) throw new Error(`unknown_plugin: ${name}`)
  const identity = entry.identity ?? name
  const info = inspectIdentity(root, identity)
  const client = await tryConnect(root)
  let loaded: string | null = null
  if (client !== null) {
    try {
      const status = await client.status()
      loaded = status.loaded.find((item) => item.id === identity)?.gen ?? null
    } finally {
      client.close()
    }
  }
  print({
    name,
    identity,
    hot: entry.hot,
    active: info?.active ?? null,
    loaded,
    gens: info?.gens ?? [],
  })
}

/** 解析 `<版本号>`：纯数字 = 世代号（`seq`），否则按 payload 哈希精确匹配。 */
function resolveGen(gens: PluginGenView[], version: string | undefined): PluginGenView {
  if (version === undefined || version.length === 0 || version.startsWith('--')) {
    throw new Error('switch expects <插件> <版本号>')
  }
  const gen = /^\d+$/.test(version)
    ? gens.find((item) => item.seq === Number(version))
    : gens.find((item) => item.payload === version)
  if (gen === undefined) throw new Error(`unknown_version: ${version}`)
  return gen
}

async function pluginSwitch(
  root: string,
  nameRaw: string | undefined,
  version: string | undefined,
): Promise<void> {
  const name = pluginName('switch', nameRaw)
  const entry = listPlugins(root).find((plugin) => plugin.name === name)
  if (entry === undefined) throw new Error(`unknown_plugin: ${name}`)
  const identity = entry.identity ?? name
  const info = inspectIdentity(root, identity)
  if (info === null) throw new Error(`unknown_identity: ${identity}`)
  const gen = resolveGen(info.gens, version)
  const client = await tryConnect(root)
  if (client !== null) {
    try {
      const status = await client.status()
      const directive: Directive = {
        kind: 'write',
        request: {
          id: `switch-${randomUUID()}`,
          op: 'set_active',
          target: { expect_pos: status.world_head.hash },
          args: { id: identity, active: gen.payload },
          by: 'cli',
        },
      }
      const result = await client.submit([directive])
      print({
        ok: true,
        name,
        identity,
        version: gen.seq,
        active: gen.payload,
        status: result.status,
      })
    } finally {
      client.close()
    }
    return
  }
  const report = runSetActive(root, identity, gen.payload)
  print({ ...report, name, version: gen.seq })
  if (!report.ok) process.exitCode = 1
}

async function pluginDomain(context: CommandContext): Promise<void> {
  const ref = context.args[0]
  if (ref === undefined || ref.startsWith('--')) {
    throw new Error('plugin expects <世界> <子命令>')
  }
  const root = resolveWorldRef(ref)
  const sub = context.args[1]
  if (sub === undefined || sub.startsWith('--')) {
    throw new Error('plugin expects <世界> <子命令>')
  }
  const rest = context.args.slice(2)
  switch (sub) {
    case 'ls':
      print({ plugins: listPlugins(root) })
      return
    case 'add':
      await pluginAdd(root, rest)
      return
    case 'upgrade':
      await pluginUpgrade(root, rest[0])
      return
    case 'remove':
      await pluginRemove(root, rest[0])
      return
    case 'info':
      await pluginInfo(root, rest[0])
      return
    case 'switch':
      await pluginSwitch(root, rest[0], rest[1])
      return
    case 'commands':
      await withClient(root, async (client) => print(await client.commands()))
      return
    default:
      await dispatchPluginCommand(root, sub, rest, context.options)
      return
  }
}

// ── 顶层派发表 ────────────────────────────────────────────

async function worldDomain(context: CommandContext): Promise<void> {
  const args = context.args
  const sub = args[0]
  switch (sub) {
    case 'ls':
      await worldLs()
      return
    case 'create':
      worldCreate(args.slice(1))
      return
    case 'remove': {
      const ref = args[1]
      if (ref === undefined || ref.startsWith('--')) throw new Error('missing_world')
      if (!unregisterWorld(ref)) throw new Error(`unknown_world: ${ref}`)
      print({ ok: true, world: ref })
      return
    }
    case 'start':
      await worldStart(args.slice(1), context.options)
      return
    case 'stop':
      await worldStop(args.slice(1))
      return
    case 'status': {
      const { root } = worldRoot(args.slice(1))
      await withClient(root, async (client) => print(await client.status()))
      return
    }
    case 'run': {
      const { root, rest } = worldRoot(args.slice(1))
      await withClient(
        root,
        async (client) => {
          const directives = parseJsonArg(rest[0])
          if (!Array.isArray(directives)) throw new Error('run expects a directives array')
          print(await client.submit(directives as Directive[]))
        },
        resolveRunTimeoutMs(context.options),
      )
      return
    }
    case 'audit': {
      const { root, rest } = worldRoot(args.slice(1))
      const filter = parseJsonArg(rest[0])
      await withClient(root, async (client) =>
        print(await client.audit(filter === null ? undefined : (filter as unknown as AuditFilter))),
      )
      return
    }
    case 'gc': {
      const { root, rest } = worldRoot(args.slice(1))
      gcWorld(root, rest[0])
      return
    }
    case 'seed': {
      const { root, rest } = worldRoot(args.slice(1))
      const report = runSeed(root, seedEntries(rest))
      print(report)
      if (!report.ok) process.exitCode = 1
      return
    }
    case 'pack': {
      const { root, rest } = worldRoot(args.slice(1))
      const { dir, identity } = packArgs(rest)
      const report = runPack(root, dir, identity)
      print(report)
      if (!report.ok) process.exitCode = 1
      return
    }
    case 'verify': {
      const { root } = worldRoot(args.slice(1))
      const report = runVerify(root)
      print(report)
      if (!report.ok) process.exitCode = 1
      return
    }
    case 'replay': {
      const { root } = worldRoot(args.slice(1))
      print(runReplay(root))
      return
    }
    case 'unseeded': {
      const { root } = worldRoot(args.slice(1))
      print(unseededIdentities(root))
      return
    }
    case 'compact': {
      const { root, rest } = worldRoot(args.slice(1))
      const strict = resolveCompactStrict(
        rest.includes('--strict'),
        process.env['CHRONO_COMPACT_STRICT'],
      )
      print(runCompact(root, { strict }))
      return
    }
    default:
      throw new Error(`unknown_command: world ${sub ?? ''}`)
  }
}

/**
 * 命令派发表：键集即顶层保留命令名集。新增顶层命令必须同时加入
 * `packages/host/common/framework-commands.ts` 的 `FRAMEWORK_COMMAND_NAMES`，否则测试红。
 */
export const handlers: Record<string, CommandHandler> = {
  world: (context) => worldDomain(context),
  plugin: (context) => pluginDomain(context),
  term: ({ args }) => {
    if (args[0] !== 'build') throw new Error(`unknown_command: term ${args[0] ?? ''}`)
    const dir = args[1]
    if (dir === undefined || dir.startsWith('--')) throw new Error('term build expects <目录>')
    const entry = resolve(HERE, '..', '..', 'toolchain', `build.${SELF_EXT}`)
    const child = spawnSync(process.execPath, [entry, resolve(process.cwd(), dir)], {
      stdio: 'inherit',
    })
    if (child.status !== 0) process.exitCode = child.status ?? 1
  },
  help: () => {
    process.stdout.write(`${helpText()}\n`)
  },
}

/** 非保留命令：按声明调用插件命令（仅经 `plugin <世界> <命令>` 到达）。 */
export async function dispatchPluginCommand(
  root: string,
  command: string,
  args: string[],
  options: EntryOptions,
): Promise<void> {
  await withClient(
    root,
    async (client) => print(await client.command(command, parseJsonArg(args[0]))),
    resolveRunTimeoutMs(options),
  )
}
