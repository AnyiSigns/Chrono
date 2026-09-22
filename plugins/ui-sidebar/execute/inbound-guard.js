// 入站面收紧：宿主的设计边界是「只开本地 socket」，而 UI 插件为浏览器另开了 127.0.0.1 HTTP 端口。
// 浏览器里任意页面都能向本端口发请求，故在此挡住三类越界：DNS rebinding（Host 伪造）、
// 跨站请求（Origin 伪造）、以及不触发 CORS 预检的「简单请求」（写方法非 JSON 体）。
// 各插件自带一份、互不 import（插件之间不得互相依赖）。

/** 只读动词：不写世界，也不要求 Origin。 */
const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * Host 只认本进程实际监听端口的两种本机写法。
 * 攻击域名解析到 127.0.0.1 后，浏览器仍会带 `Host: <攻击域名>`，故可挡 DNS rebinding。
 */
export function isAllowedHost(host, port) {
  if (host === undefined) return false
  const lower = host.trim().toLowerCase()
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}`
}

/** Origin 只认同源的两种写法；跨源（含字面量 `null`）一律拒。 */
export function isAllowedOrigin(origin, port) {
  if (origin === undefined) return false
  const lower = origin.trim().toLowerCase()
  return lower === `http://127.0.0.1:${port}` || lower === `http://localhost:${port}`
}

/**
 * 写方法要求 `application/json` 体。`text/plain` 等「简单请求」不触发 CORS 预检，
 * 卡住这条即让跨站写入无法以简单请求形态发出。
 */
export function isJsonContentType(value) {
  if (value === undefined) return false
  const mime = value.split(';', 1)[0].trim().toLowerCase()
  return mime === 'application/json'
}

/**
 * 校验一条入站请求；通过 → null，否则回拒绝信息（`status` 直接用作 HTTP 状态码）。
 *
 * Origin 缺失的口径：写方法（非 GET/HEAD）缺失 Origin 一律拒。浏览器对非 GET/HEAD 请求必带
 * Origin——跨站请求如此，同源 fetch 亦然——所以缺失 Origin 的写请求不来自页面脚本，没有放行理由；
 * 读方法（GET/HEAD）缺失 Origin 放行，因为同源导航与同源 GET 本就不带 Origin。
 */
export function guardInboundRequest(req, port) {
  const headers = req.headers
  if (!isAllowedHost(headers.host, port)) {
    return { status: 403, code: 'forbidden_host', message: 'host not allowed' }
  }
  const origin = headers.origin
  const method = (req.method ?? 'GET').toUpperCase()
  const isWrite = !READ_METHODS.has(method)
  if (origin !== undefined) {
    if (!isAllowedOrigin(origin, port)) {
      return { status: 403, code: 'forbidden_origin', message: 'origin not allowed' }
    }
  } else if (isWrite) {
    return { status: 403, code: 'forbidden_origin', message: 'origin required for write' }
  }
  if (isWrite && !isJsonContentType(headers['content-type'])) {
    return { status: 415, code: 'unsupported_media_type', message: 'application/json required' }
  }
  return null
}
