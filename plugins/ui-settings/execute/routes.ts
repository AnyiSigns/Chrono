// HTTP 路由判定（纯函数，便于单测）：本插件子应用端口上的全部入口。
// 浏览器经壳反代 `/p/ui-settings/*` 到本端口；静态模块与 `/api/*` 都在此判定。
// 事件统一走壳 `/events` 总线，本端口不再提供 SSE。

import { WEB_FILE_RE } from './static.ts'

export type Route =
  | { kind: 'entry' }
  | { kind: 'web'; name: string }
  | { kind: 'api-command' }
  | { kind: 'api-submit' }
  | { kind: 'api-secrets-put' }
  | { kind: 'api-secrets-delete' }
  | { kind: 'not-found' }

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** 判定一条请求的路由；未知路径 → not-found。 */
export function routeOf(method: string, pathname: string): Route {
  const verb = method.toUpperCase()
  if (pathname === '/entry.js') return verb === 'GET' || verb === 'HEAD' ? { kind: 'entry' } : { kind: 'not-found' }
  if (pathname === '/api/command') return verb === 'POST' ? { kind: 'api-command' } : { kind: 'not-found' }
  if (pathname === '/api/submit') return verb === 'POST' ? { kind: 'api-submit' } : { kind: 'not-found' }
  if (pathname === '/api/secrets/put') return verb === 'POST' ? { kind: 'api-secrets-put' } : { kind: 'not-found' }
  if (pathname === '/api/secrets/delete') {
    return verb === 'POST' ? { kind: 'api-secrets-delete' } : { kind: 'not-found' }
  }
  if (pathname.startsWith('/') && !pathname.slice(1).includes('/')) {
    const name = decodeSegment(pathname.slice(1))
    if (name !== null && WEB_FILE_RE.test(name)) {
      return verb === 'GET' || verb === 'HEAD' ? { kind: 'web', name } : { kind: 'not-found' }
    }
  }
  return { kind: 'not-found' }
}
