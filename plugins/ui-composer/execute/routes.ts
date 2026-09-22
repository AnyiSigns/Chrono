// HTTP 路由判定（纯函数，便于单测）：本插件子应用端口上的全部入口。
// 浏览器经壳反代 `/p/ui-composer/*` 到本端口；静态模块与 `/api/*` 都在此判定。
// 事件统一走壳 `/events` 总线，本端口不再提供 SSE。

import { WEB_FILE_RE } from './static.ts'

export type Route =
  | { kind: 'entry' }
  | { kind: 'web'; name: string }
  | { kind: 'api-command' }
  | { kind: 'api-submit' }
  | { kind: 'api-cancel' }
  | { kind: 'api-asset-get'; sha256: string | null; mime: string | null }
  | { kind: 'not-found' }

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * `/api/asset/<sha256>[/<mime>]` 的路径形态：壳反代 `/p/<id>/*` 不保留查询串，
 * 故缩略图 src 走路径段；`<mime>` 以 `encodeURIComponent` 编成单段（如 `image%2Fpng`）。
 */
function assetPathRoute(pathname: string): Route | null {
  const rest = pathname.slice('/api/asset/'.length)
  const segments = rest.split('/')
  if (segments.length < 1 || segments.length > 2) return null
  const sha256 = decodeSegment(segments[0])
  if (sha256 === null) return null
  const mime = segments.length === 2 ? decodeSegment(segments[1]) : null
  return { kind: 'api-asset-get', sha256, mime }
}

/** 判定一条请求的路由；未知路径 → not-found。 */
export function routeOf(method: string, pathname: string): Route {
  const verb = method.toUpperCase()
  if (pathname === '/entry.js') {
    return verb === 'GET' || verb === 'HEAD' ? { kind: 'entry' } : { kind: 'not-found' }
  }
  if (pathname === '/api/asset')
    return verb === 'GET'
      ? { kind: 'api-asset-get', sha256: null, mime: null }
      : { kind: 'not-found' }
  if (pathname.startsWith('/api/asset/')) {
    if (verb !== 'GET') return { kind: 'not-found' }
    return assetPathRoute(pathname) ?? { kind: 'not-found' }
  }
  if (pathname === '/api/command')
    return verb === 'POST' ? { kind: 'api-command' } : { kind: 'not-found' }
  if (pathname === '/api/submit')
    return verb === 'POST' ? { kind: 'api-submit' } : { kind: 'not-found' }
  if (pathname === '/api/cancel')
    return verb === 'POST' ? { kind: 'api-cancel' } : { kind: 'not-found' }
  if (pathname.startsWith('/') && !pathname.slice(1).includes('/')) {
    const name = decodeSegment(pathname.slice(1))
    if (name !== null && WEB_FILE_RE.test(name)) {
      return verb === 'GET' || verb === 'HEAD' ? { kind: 'web', name } : { kind: 'not-found' }
    }
  }
  return { kind: 'not-found' }
}
