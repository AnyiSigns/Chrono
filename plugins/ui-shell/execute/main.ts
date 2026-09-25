// `ui-shell` 服务进程入口：服务协议帧循环 + 主端口 HTTP 服务 + 自实现入站客户端。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影：无配置判据经入站 `config.read` 命令返回值，
// 主题偏好写经 `config.write` 命令（运行记录出世界，config owner 写自有存储）。
// 第二方向：服务发 `port.call`（反向调用 host.source.read 取 headless 入口字节）。

import { readFileSync } from 'node:fs'
import { Bridge, deriveBootMode, extractValue } from './bridge.ts'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { decodeSourceRead, HostLink } from './host-client.ts'
import { startUiServer } from './http-server.ts'
import type { ShellState, UiServer } from './http-server.ts'
import { identityInvalidatesHeadless } from './identity-events.ts'
import { InboundClient } from './inbound.ts'
import { DEFAULT_UI_PORT, ensureHeadless, ensureMounts } from './mounts.ts'
import type { HeadlessEntry } from './mounts.ts'
import { inboundSocketPath, rootFromPluginState } from './root.ts'
import { SHELL_IMPL, shellStateRecord, SseHub } from './sse.ts'
import { normalizeThemePref, themePrefOfConfig } from './theme.ts'
import { BadArgsError, isRecord } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read plugin.json: ${(err as Error).message}`)
  }
  return {}
}

const PLUGIN = readPlugin()
const IDENTITY = typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : 'ui-shell'
const IMPLEMENTS = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : ['ui-shell']
const METHODS = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'

function manifest(): Rec {
  return {
    v: '1',
    identity: IDENTITY,
    implements: IMPLEMENTS,
    methods: METHODS,
    protocol: PROTOCOL,
    state: STATE,
  }
}

const root = rootFromPluginState(process.env, process.cwd())
const stateDir = `${root}/state`
const { mounts } = ensureMounts(stateDir)
const { headless } = ensureHeadless(stateDir)

/** 解析壳自身端口（`CHRONO_UI_PORT`）；非法 / 缺省返回 null（回落 `DEFAULT_UI_PORT`）。 */
function parseShellPort(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

const sse = new SseHub()
const host = new HostLink()
const headlessCache = new Map<string, string>()
const headlessIds = new Set(headless.map((entry) => entry.id))
/** slot 客户端半边字节缓存（取代 /p/ 反代；按挂载表 entry 字段判定）。 */
const uiCache = new Map<string, string>()
const uiEntries = mounts.filter(
  (entry): entry is typeof entry & { entry: string } =>
    typeof entry.entry === 'string' && entry.entry.length > 0,
)
const uiIds = new Set(uiEntries.map((entry) => entry.id))

let connected = false
let hasDisconnected = false
let themePref = 'system'
let bootMode = 'onboarding'
let uiServer: UiServer | null = null
let exiting = false

function shellState(): ShellState {
  return { connected, theme: themePref, boot_mode: bootMode }
}

const inbound = new InboundClient({
  socketPath: inboundSocketPath(root),
  log,
  onEvent: (impl, topic, payload) => {
    sse.hostEvent(impl, topic, payload)
    if (impl === 'host' && topic === 'identity.changed') {
      // 仅清单内身份、且代码世代变化时才失效重取；数据世代与清单外身份不动缓存。
      const staleHeadless = identityInvalidatesHeadless(payload, headlessIds)
      if (staleHeadless !== null) {
        headlessCache.delete(staleHeadless)
        void refreshHeadless()
        return
      }
      const staleUi = identityInvalidatesHeadless(payload, uiIds)
      if (staleUi !== null) {
        uiCache.delete(staleUi)
        void refreshUi()
      }
      return
    }
  },
  onFrame: (frame) => {
    const run = typeof frame['run'] === 'string' ? (frame['run'] as string) : null
    const topic = run === null ? 'host.frame' : 'run.result'
    sse.broadcast({ impl: SHELL_IMPL, topic, payload: frame as unknown as Json })
  },
  onConnectionChange: (next) => {
    const prev = connected
    connected = next
    sse.connectionChanged(prev, next, themePref, hasDisconnected)
    if (!next) {
      hasDisconnected = true
      return
    }
    void refreshHeadless()
    void refreshUi()
    void refreshConfig()
  },
})
// 入站桥超时须 ≥ 宿主调用超时（`--call-timeout-ms`，缺省 30s）：否则长回合（`chat.send` 整回合同步执行）
// 期间排队的 `chat.history` 会在壳侧先超时，UI 收到伪 `transport_failed`。留一点余量以收到宿主自身的超时回帧。
const bridge = new Bridge(inbound, 35_000)

/** 取单个 headless 入口字节（经 `host.source.read`）；失败返回 null。 */
async function fetchHeadless(entry: HeadlessEntry): Promise<string | null> {
  const result = await host.call('source.read', { identity: entry.id, path: entry.entry })
  if (!result.ok) {
    log(`headless ${entry.id}: source.read failed (${result.code})`)
    return null
  }
  const decoded = decodeSourceRead(result.value)
  if (decoded === null) {
    log(`headless ${entry.id}: source.read shape invalid`)
    return null
  }
  return decoded.text
}

/** 读 headless 入口字节；首载竞态（宿主刚装配）失败时短暂退避重试一次。失败不缓存，下次请求 / 重连再试。 */
async function refreshHeadless(): Promise<void> {
  for (const entry of headless as HeadlessEntry[]) {
    if (headlessCache.has(entry.id)) continue
    let text = await fetchHeadless(entry)
    if (text === null) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (exiting) return
      text = await fetchHeadless(entry)
    }
    if (text === null) continue
    headlessCache.set(entry.id, text)
    log(`headless ${entry.id}: ${text.length} bytes cached`)
  }
}

/**
 * 取单个 slot 客户端半边字节：走插件自己的 `<id>.client.read` 命令。
 * 产物在物化目录内、被 `.worldignore` 排除，`host.source.read`（只读世界树）读不到；
 * 由插件进程读自己的包内文件回字节，宿主只路由。
 */
async function fetchUi(entry: { id: string; entry: string }): Promise<string | null> {
  const result = await bridge.command(`${entry.id}.client.read`, { path: entry.entry })
  if (!result.ok) {
    log(`ui ${entry.id}: client.read failed (${result.code})`)
    return null
  }
  const value = extractValue(result.frame)
  const text = isRecord(value) && typeof value['text'] === 'string' ? value['text'] : null
  if (text === null) {
    log(`ui ${entry.id}: client.read shape invalid`)
    return null
  }
  return text
}

/** 读 slot 客户端半边字节；首载竞态失败时短暂退避重试一次。失败不缓存，下次请求 / 重连再试。 */
async function refreshUi(): Promise<void> {
  for (const entry of uiEntries) {
    if (uiCache.has(entry.id)) continue
    let text = await fetchUi(entry)
    if (text === null) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (exiting) return
      text = await fetchUi(entry)
    }
    if (text === null) continue
    uiCache.set(entry.id, text)
    log(`ui ${entry.id}: ${text.length} bytes cached`)
  }
}

/** 经入站 `config.read` 更新无配置判据与主题偏好（服务不读投影）；变化时广播重推。 */
async function refreshConfig(): Promise<void> {
  const read = await bridge.configRead()
  if (!read.ok) return
  const nextBoot = deriveBootMode(read.value)
  const nextTheme = normalizeThemePref(themePrefOfConfig(read.value))
  const changed = nextBoot !== bootMode || nextTheme !== themePref
  bootMode = nextBoot
  themePref = nextTheme
  if (changed) sse.broadcast(shellStateRecord(connected, themePref))
}

/** 首载竞态（宿主刚装配 / 目标插件重启）退避重试一次；失败返回 null。 */
async function fetchWithRetry(fetch: () => Promise<string | null>): Promise<string | null> {
  const first = await fetch()
  if (first !== null) return first
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (exiting) return null
  return await fetch()
}

/**
 * 取 headless 入口字节（供 `/assets/headless/<id>.js`）：冷缓存时**等待**取回再回 200，
 * 不再「先 404、下次再来」——否则每次刷新都会先掉一批 404。取不到才 null（调用方回 404）。
 */
async function headlessSource(id: string): Promise<string | null> {
  const cached = headlessCache.get(id)
  if (cached !== undefined) return cached
  const entry = headless.find((item) => item.id === id)
  if (entry === undefined) return null
  const text = await fetchWithRetry(() => fetchHeadless(entry))
  if (text !== null) headlessCache.set(id, text)
  return text
}

/**
 * 取 slot 客户端半边字节（供 `/assets/ui/<id>.js`）：冷缓存时等待取回再回 200，失败才 null。
 * 取代旧的「首次未命中即 404 + 异步预热」，避免刷新时的 404 洪峰。
 */
async function uiSource(id: string): Promise<string | null> {
  const cached = uiCache.get(id)
  if (cached !== undefined) return cached
  const entry = uiEntries.find((item) => item.id === id)
  if (entry === undefined) return null
  const text = await fetchWithRetry(() => fetchUi(entry))
  if (text !== null) uiCache.set(id, text)
  return text
}

function applyThemePref(pref: string): void {
  themePref = normalizeThemePref(pref)
  sse.broadcast(shellStateRecord(connected, themePref))
}

function sendFrame(message: Json): void {
  if (exiting) return
  try {
    writeFrame(message)
  } catch (err) {
    log(`write frame failed: ${(err as Error).message}`)
  }
}

function sendError(id: string, code: string, message: string): void {
  sendFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

function parseEnv(raw: Json | undefined): CallEnv {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0 }
  return {
    run: typeof raw['run'] === 'string' ? raw['run'] : null,
    thread: typeof raw['thread'] === 'string' ? raw['thread'] : null,
    now: typeof raw['now'] === 'number' && Number.isFinite(raw['now']) ? raw['now'] : 0,
  }
}

function declaredMethods(port: string): string[] {
  const declared = METHODS[port]
  if (Array.isArray(declared)) {
    return declared.filter((item): item is string => typeof item === 'string')
  }
  return []
}

/** 本插件唯一方法：健康占位（`ui-shell.ping`）。 */
function handlePing(): { value: Json; events: { topic: string; payload: Json }[] } {
  return { value: { pong: true, identity: IDENTITY }, events: [] }
}

async function handleCall(message: Rec): Promise<void> {
  const id = typeof message['id'] === 'string' ? (message['id'] as string) : ''
  const port = message['port']
  const method = message['method']
  if (typeof port !== 'string' || typeof method !== 'string') {
    sendError(id, 'bad_args', 'port and method must be strings')
    return
  }
  if (!IMPLEMENTS.includes(port)) {
    sendError(id, 'unresolved_cap', `unknown capability ${port}`)
    return
  }
  if (!declaredMethods(port).includes(method)) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  const args = message['args']
  if (args !== undefined && args !== null && !isRecord(args)) {
    sendError(id, 'bad_args', 'args must be an object')
    return
  }
  try {
    const result = handlePing()
    sendFrame({ v: '1', id, kind: 'result', ok: true, value: result.value })
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
  }
}

function shutdown(): void {
  if (exiting) return
  exiting = true
  inbound.close()
  host.failAll('transport_failed')
  const server = uiServer
  uiServer = null
  const finish = (): void => setTimeout(() => process.exit(0), 10).unref?.()
  if (server !== null) {
    void server.close().then(finish, finish)
  } else {
    finish()
  }
}

async function handle(message: Json): Promise<void> {
  if (!isRecord(message)) return
  if (host.resolve(message)) return
  switch (message['kind']) {
    case 'hello':
      sendFrame({ id: message['id'], kind: 'manifest', ...manifest() })
      return
    case 'probe':
      sendFrame({ v: '1', id: message['id'], kind: 'pong', ok: true })
      return
    case 'reload':
      log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
      sendFrame({ v: '1', id: message['id'], kind: 'ack' })
      return
    case 'drain':
      sendFrame({ v: '1', id: message['id'], kind: 'bye' })
      shutdown()
      return
    case 'call':
      await handleCall(message)
      return
    default:
      return
  }
}

const decoder = createFrameDecoder()
let chain: Promise<void> = Promise.resolve()
process.stdin.on('data', (chunk: Buffer) => {
  let messages: Json[]
  try {
    messages = decoder.push(chunk)
  } catch (err) {
    log(`bad frame: ${(err as Error).message}`)
    return
  }
  for (const message of messages) {
    if (isRecord(message) && host.resolve(message)) continue
    chain = chain
      .then(() => handle(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

inbound.start()

const uiPort = parseShellPort(process.env['CHRONO_UI_PORT']) ?? DEFAULT_UI_PORT
startUiServer(
  {
    mounts,
    headless,
    bridge,
    sse,
    state: shellState,
    headlessSource,
    uiSource,
    applyThemePref,
    log,
  },
  uiPort,
).then(
  (server) => {
    uiServer = server
    log(`ui-shell listening on 127.0.0.1:${server.port} (pid ${process.pid})`)
    // 宿主入站 socket 在装配后才监听：延迟一次尝试取 headless 字节与配置（失败由重连兜底）
    const timer = setTimeout(() => {
      if (connected) {
        void refreshHeadless()
        void refreshUi()
        void refreshConfig()
      }
    }, 1500)
    timer.unref?.()
  },
  (err: Error) => {
    log(`cannot listen on 127.0.0.1:${uiPort}: ${err.message}`)
    process.exit(1)
  },
)
