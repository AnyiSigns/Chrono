// 本地 HTTP 测试端点：按需记录请求，并支持一次性 / 流式（SSE）应答与中途断流。
import http from 'node:http'

/** 启动一个记录请求的本地服务器；handler(req, res, record) 负责应答。 */
export function startHttpServer(handler) {
  return new Promise((resolveServer) => {
    const requests = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const record = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        requests.push(record)
        handler(req, res, record)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveServer({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** 写一个 SSE 事件块。 */
export function sseEvent(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

/** 打开 SSE 响应头。 */
export function sseHead(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
}

/** 写 JSON 响应。 */
export function jsonResponse(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 把请求体解析为对象；失败返回 null。 */
export function parseBody(record) {
  try {
    return JSON.parse(record.body)
  } catch {
    return null
  }
}

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
