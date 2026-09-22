// 本插件子应用 HTTP 服务：投递 React 构建产物 + 只读探活。
// 绑定 127.0.0.1；浏览器不直连本端口（正式形态下壳反代，验证时直连）。
// 服务不认识业务，只做静态投递；入站请求先过 guardInboundRequest。

import { createServer } from 'node:http'
import { guardInboundRequest } from './inbound-guard.js'
import { distDirOf, indexHtmlPath, readDistFile } from './static.js'
import { readFileSync } from 'node:fs'

/** 投递的产物白名单：只有 `app.js` 会被从 `dist/` 读出。 */
const DIST_WHITELIST = new Set(['app.js'])

export function startHttpServer(deps, port) {
  const log = deps.log
  const distDir = deps.distDir ?? distDirOf()
  const sockets = new Set()
  // 校验 Host 要用实际监听端口（允许调用方传 0 由系统分配）。
  let boundPort = port
  const server = createServer((req, res) => {
    void handleRequest(distDir, req, res, log, boundPort)
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

function sendBuffer(res, status, buffer, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buffer.length,
    // 本地静态一律禁缓存：产物换代后浏览器不得继续用旧 bundle。
    'cache-control': 'no-store',
  })
  res.end(buffer)
}

function sendJson(res, status, value) {
  sendBuffer(res, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json; charset=utf-8')
}

/** 读外壳 HTML；缺失回一个最小页，保证 `/` 不空。 */
function readIndexHtml() {
  try {
    return readFileSync(indexHtmlPath())
  } catch {
    return Buffer.from('<!doctype html><html><body><div id="root"></div></body></html>', 'utf8')
  }
}

async function handleRequest(distDir, req, res, log, port) {
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
  const method = (req.method ?? 'GET').toUpperCase()
  const readable = method === 'GET' || method === 'HEAD'
  try {
    if (url.pathname === '/api/state') {
      if (method !== 'GET') return sendJson(res, 404, { ok: false, code: 'not_found' })
      return sendJson(res, 200, { ok: true, impl: 'toy-react', dist: distDir })
    }
    if (readable && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendBuffer(res, 200, readIndexHtml(), 'text/html; charset=utf-8')
    }
    if (readable && url.pathname.startsWith('/') && !url.pathname.slice(1).includes('/')) {
      const name = url.pathname.slice(1)
      if (DIST_WHITELIST.has(name)) {
        const file = readDistFile(distDir, name)
        if (file === null) {
          return sendJson(res, 404, { ok: false, code: 'not_built', message: `${name} missing in dist` })
        }
        return sendBuffer(res, 200, file, 'text/javascript; charset=utf-8')
      }
    }
    return sendJson(res, 404, { ok: false, code: 'not_found', message: url.pathname })
  } catch (err) {
    log(`request failed: ${err.message}`)
    if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: 'request failed' })
    else res.destroy()
  }
}
