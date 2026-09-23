// HTTP 路由判定（纯函数，便于单测）：浏览器唯一主端口上的全部入口。
// `/p/<id>/*` 判定写死：id 在挂载表内 → 反代到子应用端口；表外（如 mcp）→ forward 帧发宿主。

import { findMount } from './mounts.ts'
import type { MountEntry } from './mounts.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

export const ASSET_NAMES = [
  'tokens.v1.css',
  'icons.v2.svg',
  'messages.v1.json',
  'favicon.svg',
] as const
export type AssetName = (typeof ASSET_NAMES)[number]

export type Route =
  | { kind: 'shell-page' }
  | { kind: 'asset'; name: AssetName }
  | { kind: 'lib'; name: string }
  | { kind: 'vendor'; name: string }
  | { kind: 'ui'; id: string }
  | { kind: 'headless'; id: string }
  | { kind: 'forward'; id: string; rest: string }
  | { kind: 'events' }
  | { kind: 'api-theme' }
  | { kind: 'api-submit' }
  | { kind: 'api-command' }
  | { kind: 'api-asset-put' }
  | { kind: 'api-asset-get' }
  | { kind: 'api-cancel' }
  | { kind: 'api-state' }
  | { kind: 'not-found' }

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function assetRoute(name: string): Route | null {
  if (name === 'favicon.svg') return { kind: 'asset', name: 'favicon.svg' }
  if (name === 'tokens.v1.css') return { kind: 'asset', name: 'tokens.v1.css' }
  if (name === 'icons.v2.svg') return { kind: 'asset', name: 'icons.v2.svg' }
  if (name === 'messages.v1.json') return { kind: 'asset', name: 'messages.v1.json' }
  return null
}

/** 判定一条请求的路由；未知路径 → not-found。 */
export function routeOf(method: string, pathname: string, mounts: MountEntry[]): Route {
  const verb = method.toUpperCase()
  if (pathname === '/' || pathname === '') {
    return verb === 'GET' || verb === 'HEAD' ? { kind: 'shell-page' } : { kind: 'not-found' }
  }
  if (pathname === '/events') {
    return verb === 'GET' ? { kind: 'events' } : { kind: 'not-found' }
  }
  if (pathname === '/favicon.svg') return { kind: 'asset', name: 'favicon.svg' }

  if (pathname.startsWith('/assets/')) {
    const rest = pathname.slice('/assets/'.length)
    const direct = assetRoute(rest)
    if (direct !== null) return verb === 'GET' || verb === 'HEAD' ? direct : { kind: 'not-found' }
    if (rest.startsWith('lib/')) {
      const name = rest.slice('lib/'.length)
      return verb === 'GET' && /^[a-z0-9-]+\.js$/.test(name)
        ? { kind: 'lib', name }
        : { kind: 'not-found' }
    }
    if (rest.startsWith('vendor/')) {
      const name = rest.slice('vendor/'.length)
      return verb === 'GET' && /^[a-z0-9.-]+\.js$/.test(name)
        ? { kind: 'vendor', name }
        : { kind: 'not-found' }
    }
    if (rest.startsWith('ui/')) {
      const file = rest.slice('ui/'.length)
      if (verb === 'GET' && file.endsWith('.js') && file.length > 3) {
        const id = decodeSegment(file.slice(0, -3))
        // id 必须是安全单段（挂载表 id 形态），挡住 `..` / 分隔符等路径穿越。
        if (id !== null && /^[A-Za-z0-9_-]+$/.test(id)) return { kind: 'ui', id }
      }
      return { kind: 'not-found' }
    }
    if (rest.startsWith('headless/')) {
      const file = rest.slice('headless/'.length)
      if (verb === 'GET' && file.endsWith('.js') && file.length > 3) {
        const id = decodeSegment(file.slice(0, -3))
        if (id !== null && id.length > 0) return { kind: 'headless', id }
      }
      return { kind: 'not-found' }
    }
    return { kind: 'not-found' }
  }

  if (pathname.startsWith('/p/')) {
    if (verb !== 'GET' && verb !== 'POST' && verb !== 'PUT' && verb !== 'DELETE') {
      return { kind: 'not-found' }
    }
    const remainder = pathname.slice('/p/'.length)
    const slash = remainder.indexOf('/')
    const rawId = slash < 0 ? remainder : remainder.slice(0, slash)
    const rawRest = slash < 0 ? '' : remainder.slice(slash + 1)
    const id = decodeSegment(rawId)
    if (id === null || id.length === 0) return { kind: 'not-found' }
    // 挂载表内的 UI 插件客户端半边改由插件自交付（壳以 /assets/ui/<id>.js 同源服务），
    // 不再有 HTTP 端口可反代；表外身份（如 mcp）仍转 forward 帧发宿主按名路由。
    if (findMount(mounts, id) !== null) return { kind: 'not-found' }
    return { kind: 'forward', id, rest: rawRest }
  }

  switch (pathname) {
    case '/api/theme':
      return verb === 'POST' ? { kind: 'api-theme' } : { kind: 'not-found' }
    case '/api/submit':
      return verb === 'POST' ? { kind: 'api-submit' } : { kind: 'not-found' }
    case '/api/command':
      return verb === 'POST' ? { kind: 'api-command' } : { kind: 'not-found' }
    case '/api/asset':
      if (verb === 'POST') return { kind: 'api-asset-put' }
      if (verb === 'GET') return { kind: 'api-asset-get' }
      return { kind: 'not-found' }
    case '/api/cancel':
      return verb === 'POST' ? { kind: 'api-cancel' } : { kind: 'not-found' }
    case '/api/state':
      return verb === 'GET' ? { kind: 'api-state' } : { kind: 'not-found' }
    default:
      return { kind: 'not-found' }
  }
}

/**
 * `/p/<id>/<rest>` → 宿主命令名：路径段以 `.` 连接，且保证带 `<id>.` 前缀。
 * 例：`/p/mcp/discover` → `mcp.discover`；`/p/mcp/tools/list` → `mcp.tools.list`。
 */
export function forwardCommandName(id: string, rest: string): string | null {
  const segments = rest
    .split('/')
    .map((segment) => decodeSegment(segment))
    .filter((segment): segment is string => segment !== null && segment.length > 0)
  if (segments.length === 0) return null
  const joined = segments.join('.')
  return joined.startsWith(`${id}.`) ? joined : `${id}.${joined}`
}

/** forward 帧的 args：优先 JSON body 对象；否则取查询串键值；都无 → null。 */
export function buildForwardArgs(method: string, query: URLSearchParams, body: Json): Json {
  if (isRecord(body)) return body
  if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') {
    const args: Rec = {}
    let has = false
    for (const [key, value] of query) {
      args[key] = value
      has = true
    }
    return has ? args : null
  }
  return null
}
