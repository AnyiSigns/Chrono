// `ui-shell` 服务进程入口：服务协议帧循环 + 主端口 HTTP 服务 + 自实现入站客户端。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影：无配置判据与主题改写都经入站 `config.read` 命令返回值。
// 第二方向：服务发 `port.call`（反向调用 host.source.read 取 headless 入口字节）。

import { readFileSync } from 'node:fs'
import { Bridge, deriveBootMode } from './bridge.ts'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { decodeSourceRead, HostLink } from './host-client.ts'
import { startUiServer } from './http-server.ts'
import type { ShellState, UiServer } from './http-server.ts'
import { InboundClient } from './inbound.ts'
import { DEFAULT_UI_PORT, ensureHeadless, ensureMounts, parsePort } from './mounts.ts'
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
const { mounts } = ensureMounts(stateDir, process.env)
const { headless } = ensureHeadless(stateDir)

const sse = new SseHub()
const host = new HostLink()
const headlessCache = new Map<string, string>()

let connected = false
let hasDisconnected = false
let themePref = 'system'
let bootMode = 'onboarding'
let uiServer: UiServer | null = null
let exiting = false

function shellState(): ShellState {
  return { connected, theme: themePref, boot_mode: bootMode }
}

/** 写 config 的 run（`submit` 回 accepted 时写尚未落账）；run 终局后重推无配置判据。 */
const configRuns = new Set<string>()

function trackConfigRun(run: string): void {
  configRuns.add(run)
}

function finishConfigRun(run: string): void {
  if (!configRuns.delete(run)) return
  void refreshConfig()
}

const inbound = new InboundClient({
  socketPath: inboundSocketPath(root),
  log,
  onEvent: (impl, topic, payload) => {
    sse.hostEvent(impl, topic, payload)
    if (topic === 'run.finished' && isRecord(payload) && typeof payload['run'] === 'string') {
      finishConfigRun(payload['run'])
    }
  },
  onFrame: (frame) => {
    const run = typeof frame['run'] === 'string' ? (frame['run'] as string) : null
    const topic = run === null ? 'host.frame' : 'run.result'
    sse.broadcast({ impl: SHELL_IMPL, topic, payload: frame as unknown as Json })
    if (run !== null) finishConfigRun(run)
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
    void refreshConfig()
  },
})
const bridge = new Bridge(inbound)

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

function headlessSource(id: string): string | null {
  const cached = headlessCache.get(id)
  if (cached !== undefined) return cached
  // 首次未命中：触发一次异步取字节，本次请求 404，下次可得。
  if (connected) void refreshHeadless()
  return null
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

const uiPort = parsePort(process.env['CHRONO_UI_PORT']) ?? DEFAULT_UI_PORT
startUiServer(
  {
    mounts,
    headless,
    bridge,
    sse,
    state: shellState,
    headlessSource,
    applyThemePref,
    refreshConfig,
    trackConfigRun,
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
