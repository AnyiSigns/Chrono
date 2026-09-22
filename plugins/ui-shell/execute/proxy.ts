// 子应用反代：`/p/<id>/*`（id 在挂载表内）→ 该子应用端口（同源、无 iframe）。
// 壳不直连插件服务（红线 3），反代只到子应用自己的 HTTP 端口；失败回 502 供 slot 占位。

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ProxyTarget {
  port: number
  host?: string
}

/** 反代一条请求到子应用端口；流式转发请求体与响应体，错误回 502。 */
export function proxyRequest(
  target: ProxyTarget,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
): void {
  const headers: { [key: string]: string | string[] | undefined } = { ...req.headers }
  // 子应用自带入站校验：Host 由本反代按目标端口重写（删掉后 Node 依 host/port 自动生成），
  // Origin 则改写成目标子应用自己的源——浏览器带的 Origin 指向壳端口，对子应用是跨源，
  // 若原样透传会被子应用拒绝；改写后既让正常请求按同源通过，也不放行任何伪造源。
  delete headers['host']
  delete headers['connection']
  if (headers['origin'] !== undefined) {
    headers['origin'] = `http://127.0.0.1:${target.port}`
  }
  const proxyReq = httpRequest(
    {
      host: target.host ?? '127.0.0.1',
      port: target.port,
      method: req.method,
      path: `/${rest}`,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', () => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: 'ui_unreachable', message: 'sub-app unreachable' }))
  })
  req.pipe(proxyReq)
}
