// 本插件子应用 HTTP 服务：静态浏览器模块 + 入站桥（command / submit / cancel）。
// 事件统一走壳 `/events` 总线，本端口不再提供 SSE；绑定 127.0.0.1，浏览器不直连本端口。

import { createServer } from 'node:http'
import { log as defaultLog } from './frames.js'
import { guardInboundRequest } from './inbound-guard.js'
import { routeOf } from './routes.js'
import { readWebFile, webDirOf } from './static.js'
import { isRecord } from './types.js'

const MAX_BODY_BYTES = 12 * 1024 * 1024

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 读请求体并解析 JSON；空体 → null；非法 / 超限 → 抛错（调用方回 400）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  if (size === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function pickString(record, key) {
  if (record === null) return null
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function handleCommand(deps, req, res) {
  let body
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
  const args = record === null || record['args'] === undefined ? null : record['args']
  const thread = pickString(record, 'thread')
  const result = await deps.bridge.commandValue(name, args, thread === null ? undefined : { thread })
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  const frame = result.frame ?? {}
  sendJson(res, 200, {
    ok: true,
    kind: frame['kind'] ?? null,
    status: frame['status'] ?? null,
    value: result.value,
  })
}

async function handleSubmit(deps, req, res) {
  let body
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
  sendJson(res, 202, { ok: true, run: frame['run'] ?? null, status: frame['status'] ?? null })
}

/** 真取消一个 run：入站协议 `cancel{run}`（非当前线程后台回合的收回入口）。 */
async function handleCancel(deps, req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'bad json body' })
    return
  }
  const record = isRecord(body) ? body : null
  const run = pickString(record, 'run')
  if (run === null) {
    sendJson(res, 400, { ok: false, code: 'bad_directive', message: 'run required' })
    return
  }
  const result = await deps.bridge.cancel(run)
  if (!result.ok) {
    sendJson(res, 502, { ok: false, code: result.code, message: result.message })
    return
  }
  sendJson(res, 202, { ok: true, run })
}

function serveWeb(webDir, name, res) {
  const source = readWebFile(webDir, name)
  if (source === null) {
    sendJson(res, 404, { ok: false, code: 'not_found', message: name })
    return
  }
  sendText(res, 200, source, 'text/javascript; charset=utf-8')
}

/** 起子应用 HTTP 服务（绑定 127.0.0.1）。 */
export function startUiServer(deps, port) {
  const log = deps.log ?? defaultLog
  const webDir = deps.webDir ?? webDirOf()
  const sockets = new Set()
  // 校验 Host / Origin 要用实际监听端口（允许调用方传 0 由系统分配）。
  let boundPort = port
  const server = createServer((req, res) => {
    void handleRequest(deps, webDir, req, res, log, boundPort)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (address !== null && typeof address === 'object') boundPort = address.port
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          }),
      })
    })
  })
}

async function handleRequest(deps, webDir, req, res, log, port) {
  const rejection = guardInboundRequest(req, port)
  if (rejection !== null) {
    sendJson(res, rejection.status, { ok: false, code: rejection.code, message: rejection.message })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routeOf(req.method ?? 'GET', url.pathname)
  try {
    switch (route.kind) {
      case 'entry':
        serveWeb(webDir, 'entry.js', res)
        return
      case 'web':
        serveWeb(webDir, route.name, res)
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
      default:
        sendJson(res, 404, { ok: false, code: 'not_found', message: url.pathname })
        return
    }
  } catch (err) {
    log(`request failed: ${err.message}`)
    if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: 'request failed' })
    else res.destroy()
  }
}
