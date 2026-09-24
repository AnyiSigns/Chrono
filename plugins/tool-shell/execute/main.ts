// `tool-shell` 服务进程入口：宿主服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道；执行与密钥解析全部经反向调用。

import { spawnSync } from 'node:child_process'

import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { createHandlers } from './methods.ts'
import { PortLink, RemoteExec, RemoteSecrets } from './port-link.ts'
import { IDENTITY, IMPLEMENTS, METHODS, PROTOCOL, STATE } from './plugin.ts'
import { ToolError, isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/**
 * 解析命令形态的 PowerShell 解释器，按优先级探测：`pwsh`（PowerShell Core，二进制名跨版本恒定，
 * 比 7 新的稳定版同名）→ `pwsh-preview`（预览版）→ `powershell.exe`（仅 Windows，系统自带 5.1）。
 * 探测是存在性冒烟（`exit 0`），不校验版本，故更新版本无需改代码；服务启动时一次性执行，结果注入 invoke。
 */
function resolveShellCommand(): string {
  const candidates =
    process.platform === 'win32'
      ? ['pwsh', 'pwsh-preview', 'powershell.exe']
      : ['pwsh', 'pwsh-preview']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (probe.status === 0) return candidate
  }
  return candidates[0]
}

const LINK = new PortLink((message) => writeFrame(message))
const HANDLERS = createHandlers({
  exec: new RemoteExec(LINK),
  secrets: new RemoteSecrets(LINK),
  shell: resolveShellCommand(),
})

const DECLARED_METHODS = new Set<string>(
  Array.isArray(METHODS[IDENTITY])
    ? (METHODS[IDENTITY] as Json[]).filter((item): item is string => typeof item === 'string')
    : Object.keys(HANDLERS),
)

let exiting = false

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
  if (!DECLARED_METHODS.has(method)) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  const handler = HANDLERS[method]
  if (handler === undefined) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  const args = message['args']
  if (args !== undefined && args !== null && !isRecord(args)) {
    sendError(id, 'bad_args', 'args must be an object')
    return
  }
  let value: Json
  try {
    value = await handler(args ?? null, id)
  } catch (err) {
    if (err instanceof ToolError) {
      sendError(id, err.code, err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
    return
  }
  sendFrame({ v: '1', id, kind: 'result', ok: true, value })
}

/** 停机：未结算的反向调用作数据失败，然后退出（先让协议帧写完）。 */
function shutdown(): void {
  if (exiting) return
  exiting = true
  LINK.failAll()
  setTimeout(() => process.exit(0), 10).unref?.()
}

async function handle(message: Json): Promise<void> {
  if (!isRecord(message)) return
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
// 串行链：保证同一连接上的消息按到达序处理；反向调用应答立即结算（不排队），
// 否则正在 await port.result 的 call 会把链堵死。
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
    if (isRecord(message) && LINK.settle(message)) continue
    chain = chain
      .then(() => handle(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

log(`service started (pid ${process.pid})`)
