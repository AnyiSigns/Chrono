// 壳 HTTP 服务：浏览器唯一主端口的全部路由。
// 只做转译与静态服务，不认识业务；绑定 127.0.0.1。

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse, Socket } from 'node:http'
import {
  loadFavicon,
  loadIcons,
  loadLib,
  loadShellHtml,
  loadTokens,
  loadVendor,
  readAsset,
  webDirOf,
} from './assets.ts'
import type { AssetContent } from './assets.ts'
import { Bridge, extractValue } from './bridge.ts'
import { log as defaultLog } from './frames.ts'
import { guardInboundRequest } from './inbound-guard.ts'
import { FALLBACK_MESSAGES } from './messages.ts'
import type { HeadlessEntry, MountEntry } from './mounts.ts'
import { buildForwardArgs, forwardCommandName, routeOf } from './routes.ts'
import type { Route } from './routes.ts'
import { SseHub, shellStateRecord } from './sse.ts'
import { injectThemeScript, normalizeThemePref, toConfigTheme } from './theme.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 壳运行态（供 `/api/state` 与 SSE 状态事件）。 */
export interface ShellState {
  connected: boolean
  /** 主题偏好：`light` / `dark` / `system`（解析为实际主题在浏览器侧）。 */
  theme: string
  boot_mode: string
}

export interface UiServerDeps {
  mounts: MountEntry[]
  headless: HeadlessEntry[]
  bridge: Bridge
  sse: SseHub
  state: () => ShellState
  /** headless 入口字节（经 host.source.read 取回并缓存）；冷缓存时等待取回，无 → null。 */
  headlessSource: (id: string) => Promise<string | null>
  /** slot 客户端半边字节（经 host.source.read 取回并缓存，取代 /p/ 反代）；冷缓存时等待取回，无 → null。 */
  uiSource: (id: string) => Promise<string | null>
  /** 写主题偏好后的运行态更新（缓存 + 广播）。 */
  applyThemePref: (pref: string) => void
  webDir?: string
  log?: (line: string) => void
}

export interface UiServer {
  server: Server
  port: number
  close: () => Promise<void>
}

/** 壳页面引导数据注入点（壳页面里以本注释占位，服务端替换为 JSON）。 */
export const BOOTSTRAP_PLACEHOLDER = '/*__CHRONO_BOOTSTRAP__*/'

/**
 * 注入引导数据。壳页面写成 `= /*占位*\/{};`：占位符后紧跟 `{}` 作未注入时的兜底默认值，
 * 故连同 `{}` 一起替换，避免留下两个相邻对象字面量（语法错误）；函数式替换防 `$` 序列被解释。
 */
export function injectBootstrap(html: string, data: Json): string {
  return html.replace(`${BOOTSTRAP_PLACEHOLDER}{}`, () => JSON.stringify(data))
}

const CONTENT_TYPES: { [name: string]: string } = {
  'tokens.v1.css': 'text/css; charset=utf-8',
  'icons.v2.svg': 'image/svg+xml; charset=utf-8',
  'messages.v1.json': 'application/json; charset=utf-8',
  'favicon.svg': 'image/svg+xml; charset=utf-8',
}

const MAX_BODY_BYTES = 12 * 1024 * 1024

function sendJson(res: ServerResponse, status: number, value: Json): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    // 壳自有静态一律禁缓存：降级内容（如空 sprite）若被浏览器启发式缓存，
    // 页面上的 `<use href="/assets/icons.v2.svg#…">` 会长期解析不到目标而静默留白。
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读请求体并解析 JSON；空体 → null；非法 / 超限 → 抛错（调用方回 400）。 */
async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large')
    chunks.push(buffer)
  }
  if (size === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json
}

function pickString(record: Rec | null, key: string): string | null {
  if (record === null) return null
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function handleTheme(
  deps: UiServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Json
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'bad json body' })
    return
  }
  const pref = normalizeThemePref(pickString(isRecord(body) ? body : null, 'theme') ?? 'system')
  // 主题是运行记录（界面配置），已出世界：写走 config owner 的 `config.write` 命令（服务读-改-写自有存储）。
  const result = await deps.bridge.command('config.write', { patch: { ui: { theme: toConfigTheme(pref) } } })
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  deps.applyThemePref(pref)
  const status = result.frame === null ? null : (result.frame['status'] as Json)
  sendJson(res, 200, { ok: true, theme: pref, status })
}

async function handleSubmit(
  deps: UiServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Json
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'bad json body' })
    return
  }
  const record = isRecord(body) ? body : null
  const directives =
    record === null
      ? null
      : Array.isArray(record['directives'])
        ? record['directives']
        : record['directive'] !== undefined
          ? [record['directive']]
          : null
  if (directives === null) {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'directive required' })
    return
  }
  const thread = pickString(record, 'thread')
  const result = await deps.bridge.submit(directives, thread === null ? undefined : { thread })
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  const frame = result.frame ?? {}
  sendJson(res, 202, {
    ok: true,
    run: (frame['run'] ?? null) as Json,
    status: (frame['status'] ?? null) as Json,
  })
}

async function handleCommand(
  deps: UiServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Json
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'bad json body' })
    return
  }
  const record = isRecord(body) ? body : null
  const name = pickString(record, 'name')
  if (name === null) {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'name required' })
    return
  }
  const args = record === null || record['args'] === undefined ? null : (record['args'] as Json)
  const thread = pickString(record, 'thread')
  const result = await deps.bridge.command(name, args, thread === null ? undefined : { thread })
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  const frame = result.frame ?? {}
  sendJson(res, 200, {
    ok: true,
    kind: (frame['kind'] ?? null) as Json,
    status: (frame['status'] ?? null) as Json,
    observations: (frame['observations'] ?? null) as Json,
    value: extractValue(result.frame),
  })
}

async function handleAssetPut(
  deps: UiServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Json
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_asset', message: 'bad json body' })
    return
  }
  const record = isRecord(body) ? body : null
  const mime = pickString(record, 'mime')
  const bytes = pickString(record, 'bytes')
  if (mime === null || bytes === null) {
    sendJson(res, 400, { ok: false, code: 'bad_asset', message: 'mime and bytes required' })
    return
  }
  const result = await deps.bridge.assetPut(mime, bytes)
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  sendJson(res, 200, { ok: true, ref: (result.frame?.['ref'] ?? null) as Json })
}

async function handleAssetGet(
  deps: UiServerDeps,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const sha256 = url.searchParams.get('sha256')
  if (sha256 === null || !/^[0-9a-f]{64}$/.test(sha256)) {
    sendJson(res, 400, { ok: false, code: 'bad_asset', message: 'sha256 required' })
    return
  }
  const result = await deps.bridge.assetGet(sha256)
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  const frame = result.frame ?? {}
  sendJson(res, 200, {
    ok: true,
    sha256: (frame['sha256'] ?? null) as Json,
    size: (frame['size'] ?? null) as Json,
    bytes: (frame['bytes'] ?? null) as Json,
  })
}

async function handleCancel(
  deps: UiServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Json
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'bad json body' })
    return
  }
  const run = pickString(isRecord(body) ? body : null, 'run')
  if (run === null) {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'run required' })
    return
  }
  const result = await deps.bridge.cancel(run)
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  sendJson(res, 200, { ok: true, run })
}

async function handleForward(
  deps: UiServerDeps,
  route: Extract<Route, { kind: 'forward' }>,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const command = forwardCommandName(route.id, route.rest)
  if (command === null) {
    sendJson(res, 400, { ok: false, code: 'unknown_command', message: 'command required' })
    return
  }
  let body: Json = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { ok: false, code: 'bad_args', message: 'bad json body' })
      return
    }
  }
  const args = buildForwardArgs(req.method ?? 'GET', url.searchParams, body)
  const result = await deps.bridge.forward(route.id, command, args)
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  const frame = result.frame ?? {}
  sendJson(res, 200, {
    ok: true,
    identity: route.id,
    command,
    status: (frame['status'] ?? null) as Json,
    observations: (frame['observations'] ?? null) as Json,
  })
}

function handleEvents(deps: UiServerDeps, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  deps.sse.add(res)
  const current = deps.state()
  res.write(`data: ${JSON.stringify(shellStateRecord(current.connected, current.theme))}\n\n`)
  const cleanup = (): void => {
    deps.sse.remove(res)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

function serveShellPage(deps: UiServerDeps, webDir: string, res: ServerResponse): void {
  const current = deps.state()
  const { text } = loadShellHtml(webDir)
  const withTheme = injectThemeScript(text, current.theme)
  const html = injectBootstrap(withTheme, {
    mounts: deps.mounts as unknown as Json,
    headless: deps.headless as unknown as Json,
    theme: current.theme,
  })
  sendText(res, 200, html, 'text/html; charset=utf-8')
}

function serveAsset(
  deps: UiServerDeps,
  webDir: string,
  route: Extract<Route, { kind: 'asset' }>,
  res: ServerResponse,
): void {
  let content: AssetContent
  if (route.name === 'tokens.v1.css') content = loadTokens(webDir)
  else if (route.name === 'icons.v2.svg') content = loadIcons(webDir)
  else if (route.name === 'favicon.svg') content = loadFavicon(webDir)
  else content = readAsset(webDir, 'messages.v1.json', JSON.stringify(FALLBACK_MESSAGES, null, 2))
  // 降级不阻塞功能，但必须留痕：否则图标 / token 静默变空很难定位。
  if (content.fallback) (deps.log ?? defaultLog)(`asset fallback: ${route.name}`)
  sendText(res, 200, content.text, CONTENT_TYPES[route.name] ?? 'application/octet-stream')
}

/** 起壳 HTTP 服务（绑定 127.0.0.1）。 */
export function startUiServer(deps: UiServerDeps, port: number): Promise<UiServer> {
  const log = deps.log ?? defaultLog
  const webDir = deps.webDir ?? webDirOf()
  const sockets = new Set<Socket>()
  // 校验 Host / Origin 要用实际监听端口（允许调用方传 0 由系统分配）。
  let boundPort = port
  const server = createServer((req, res) => {
    void handleRequest(deps, webDir, req, res, log, boundPort)
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise<UiServer>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (address !== null && typeof address === 'object') boundPort = address.port
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            // SSE 先优雅收尾（发终止块），再销毁其余 socket；避免浏览器报流异常中断。
            deps.sse.closeAll?.()
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          }),
      })
    })
  })
}

async function handleRequest(
  deps: UiServerDeps,
  webDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  log: (line: string) => void,
  port: number,
): Promise<void> {
  const rejection = guardInboundRequest(req, port)
  if (rejection !== null) {
    sendJson(res, rejection.status, {
      ok: false,
      code: rejection.code,
      message: rejection.message,
    })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routeOf(req.method ?? 'GET', url.pathname, deps.mounts)
  try {
    switch (route.kind) {
      case 'shell-page':
        serveShellPage(deps, webDir, res)
        return
      case 'asset':
        serveAsset(deps, webDir, route, res)
        return
      case 'lib': {
        const content = loadLib(webDir, route.name)
        if (content === null) {
          sendJson(res, 404, { ok: false, code: 'not_found', message: route.name })
          return
        }
        sendText(res, 200, content.text, 'text/javascript; charset=utf-8')
        return
      }
      case 'vendor': {
        const content = loadVendor(webDir, route.name)
        if (content === null) {
          sendJson(res, 404, { ok: false, code: 'not_found', message: route.name })
          return
        }
        sendText(res, 200, content.text, 'text/javascript; charset=utf-8')
        return
      }
      case 'ui': {
        const source = await deps.uiSource(route.id)
        if (source === null) {
          sendJson(res, 404, { ok: false, code: 'not_found', message: route.id })
          return
        }
        sendText(res, 200, source, 'text/javascript; charset=utf-8')
        return
      }
      case 'headless': {
        const source = await deps.headlessSource(route.id)
        if (source === null) {
          sendJson(res, 404, { ok: false, code: 'not_found', message: route.id })
          return
        }
        sendText(res, 200, source, 'text/javascript; charset=utf-8')
        return
      }
      case 'events':
        handleEvents(deps, req, res)
        return
      case 'forward':
        await handleForward(deps, route, req, url, res)
        return
      case 'api-theme':
        await handleTheme(deps, req, res)
        return
      case 'api-submit':
        await handleSubmit(deps, req, res)
        return
      case 'api-command':
        await handleCommand(deps, req, res)
        return
      case 'api-asset-put':
        await handleAssetPut(deps, req, res)
        return
      case 'api-asset-get':
        await handleAssetGet(deps, url, res)
        return
      case 'api-cancel':
        await handleCancel(deps, req, res)
        return
      case 'api-state': {
        const current = deps.state()
        sendJson(res, 200, {
          ok: true,
          connected: current.connected,
          theme: current.theme,
          boot_mode: current.boot_mode,
        })
        return
      }
      default:
        sendJson(res, 404, { ok: false, code: 'not_found', message: url.pathname })
        return
    }
  } catch (err) {
    log(`request failed: ${(err as Error).message}`)
    if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: 'request failed' })
    else res.destroy()
  }
}
