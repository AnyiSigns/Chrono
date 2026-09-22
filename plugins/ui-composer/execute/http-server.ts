// 本插件子应用 HTTP 服务：静态浏览器模块 + 自己的 `/events` SSE + 入站桥（command / submit / cancel / asset）。
// 只做转译与静态服务，不认识业务；绑定 127.0.0.1。浏览器不直连本端口，壳反代 `/p/ui-composer/*`。

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse, Socket } from 'node:http'
import { Bridge } from './bridge.ts'
import { COMPOSER_IMPL, composerStateRecord, SseHub } from './events.ts'
import { log as defaultLog } from './frames.ts'
import { routeOf } from './routes.ts'
import type { Route } from './routes.ts'
import { readWebFile, webDirOf } from './static.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

const MAX_BODY_BYTES = 12 * 1024 * 1024
const SHA256_RE = /^[0-9a-f]{64}$/

export interface UiServerDeps {
  bridge: Bridge
  sse: SseHub
  connected: () => boolean
  webDir?: string
  log?: (line: string) => void
}

export interface UiServer {
  server: Server
  port: number
  close: () => Promise<void>
}

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
  })
  res.end(text)
}

function sendBytes(res: ServerResponse, status: number, bytes: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.length,
    'cache-control': 'no-store',
  })
  res.end(bytes)
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

async function handleCommand(
  deps: UiServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Json
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_args', message: 'bad json body' })
    return
  }
  const record = isRecord(body) ? body : null
  const name = pickString(record, 'name')
  if (name === null) {
    sendJson(res, 400, { ok: false, code: 'bad_args', message: 'name required' })
    return
  }
  const args = record === null || record['args'] === undefined ? null : (record['args'] as Json)
  const thread = pickString(record, 'thread')
  const result = await deps.bridge.commandValue(
    name,
    args,
    thread === null ? undefined : { thread },
  )
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  const frame = result.frame ?? {}
  sendJson(res, 200, {
    ok: true,
    kind: (frame['kind'] ?? null) as Json,
    status: (frame['status'] ?? null) as Json,
    value: result.value,
  })
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

async function handleAssetGet(
  deps: UiServerDeps,
  url: URL,
  route: Extract<Route, { kind: 'api-asset-get' }>,
  res: ServerResponse,
): Promise<void> {
  const sha256 = route.sha256 ?? url.searchParams.get('sha256')
  if (sha256 === null || !SHA256_RE.test(sha256)) {
    sendJson(res, 400, { ok: false, code: 'bad_asset', message: 'sha256 required' })
    return
  }
  const result = await deps.bridge.assetGet(sha256)
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  const frame = result.frame ?? {}
  const encoded = frame['bytes']
  if (typeof encoded !== 'string') {
    sendJson(res, 502, { ok: false, code: 'asset_missing', message: 'bytes missing' })
    return
  }
  const mime =
    route.mime ??
    url.searchParams.get('mime') ??
    (typeof frame['mime'] === 'string' ? frame['mime'] : '')
  const contentType = mime.length > 0 ? mime : 'application/octet-stream'
  sendBytes(res, 200, Buffer.from(encoded, 'base64'), contentType)
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
  res.write(`data: ${JSON.stringify(composerStateRecord(deps.connected()))}\n\n`)
  const cleanup = (): void => {
    deps.sse.remove(res)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

function serveWeb(
  webDir: string,
  route: Extract<Route, { kind: 'web' }>,
  res: ServerResponse,
): void {
  const source = readWebFile(webDir, route.name)
  if (source === null) {
    sendJson(res, 404, { ok: false, code: 'not_found', message: route.name })
    return
  }
  sendText(res, 200, source, 'text/javascript; charset=utf-8')
}

/** 起子应用 HTTP 服务（绑定 127.0.0.1）。 */
export function startUiServer(deps: UiServerDeps, port: number): Promise<UiServer> {
  const log = deps.log ?? defaultLog
  const webDir = deps.webDir ?? webDirOf()
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    void handleRequest(deps, webDir, req, res, log)
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
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
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
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routeOf(req.method ?? 'GET', url.pathname)
  try {
    switch (route.kind) {
      case 'entry':
        serveWeb(webDir, { kind: 'web', name: 'entry.js' }, res)
        return
      case 'web':
        serveWeb(webDir, route, res)
        return
      case 'events':
        handleEvents(deps, req, res)
        return
      case 'api-command':
        await handleCommand(deps, req, res)
        return
      case 'api-submit':
        await handleSubmit(deps, req, res)
        return
      case 'api-cancel':
        await handleCancel(deps, req, res)
        return
      case 'api-asset-get':
        await handleAssetGet(deps, url, route, res)
        return
      case 'api-state':
        sendJson(res, 200, { ok: true, connected: deps.connected(), impl: COMPOSER_IMPL })
        return
      default:
        sendJson(res, 404, { ok: false, code: 'not_found', message: url.pathname })
        return
    }
  } catch (err) {
    log(`request failed: ${(err as Error).message}`)
    if (!res.headersSent)
      sendJson(res, 500, { ok: false, code: 'internal', message: 'request failed' })
    else res.destroy()
  }
}
