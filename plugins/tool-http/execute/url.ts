// URL 解析、内网判定与规范化：规范化结果用于去重，同输入同输出。

/** 只接受 http(s) 且带主机名的 URL；其余返回 null。 */
export function parseHttpUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname.length === 0) return null
  return url
}

function isPrivateV4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b, c] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

/** 解析 IPv6 为 16 字节；含 `::` 压缩、内嵌 IPv4、zone id。非法返回 null。 */
function parseIpv6(raw: string): number[] | null {
  let host = raw
  const zoneIndex = host.indexOf('%')
  if (zoneIndex !== -1) host = host.slice(0, zoneIndex)
  if (host.length === 0) return null
  const halves = host.split('::')
  if (halves.length > 2) return null
  const parseHextets = (text: string): number[] | null => {
    if (text.length === 0) return []
    const groups = text.split(':')
    const result: number[] = []
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] ?? ''
      if (group.length === 0) return null
      if (group.includes('.')) {
        if (index !== groups.length - 1) return null
        const octets = group.split('.').map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
          return null
        }
        result.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0))
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
        result.push(parseInt(group, 16))
      }
    }
    return result
  }
  const head = parseHextets(halves[0] ?? '')
  if (head === null) return null
  let hextets: number[]
  if (halves.length === 1) {
    if (head.length !== 8) return null
    hextets = head
  } else {
    const tail = parseHextets(halves[1] ?? '')
    if (tail === null) return null
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    hextets = [...head, ...new Array<number>(fill).fill(0), ...tail]
  }
  return hextets.flatMap((value) => [(value >> 8) & 0xff, value & 0xff])
}

function isPrivateV6(host: string): boolean {
  const bytes = parseIpv6(host)
  // 解析不了按 fail-closed 视为内网（宁可误拒）。
  if (bytes === null) return true
  if (bytes.every((value) => value === 0)) return true
  const isLoopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1
  if (isLoopback) return true
  if ((bytes[0]! & 0xfe) === 0xfc) return true
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true
  if (bytes[0] === 0xff) return true
  const v4Mapped =
    bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  const v4Compatible = bytes.slice(0, 12).every((value) => value === 0)
  if (v4Mapped || v4Compatible) {
    return isPrivateV4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`)
  }
  return false
}

/** 回环 / 私网 / 链路本地 / 内网域名判定。 */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  // 归一尾点：`localhost.` / `127.0.0.1.` 与去尾点形态等价。
  host = host.replace(/\.+$/, '')
  if (host.length === 0) return true
  const suffixes = ['.localhost', '.local', '.internal', '.lan', '.home']
  if (host === 'localhost' || suffixes.some((suffix) => host.endsWith(suffix))) return true
  if (host.includes(':')) return isPrivateV6(host)
  return isPrivateV4(host)
}

/** 规范化：小写协议与主机、去默认端口与片段、去尾斜杠、查询参数按键值排序。 */
export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase()
  const defaultPort =
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  if (defaultPort) url.port = ''
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '')
  }
  const pairs = [...url.searchParams.entries()].map(([key, value]) => [key, value] as const)
  pairs.sort((left, right) => {
    if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1
    if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1
    return 0
  })
  url.search = ''
  for (const [key, value] of pairs) url.searchParams.append(key, value)
  return url.toString()
}

/** 拼接查询参数（键值按给定顺序，确定性）。 */
export function withQuery(endpoint: string, params: Record<string, string>): string {
  const url = new URL(endpoint)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

/** 取 origin（协议 + 主机 + 端口），用于 robots.txt 定位。 */
export function originOf(raw: string): string {
  const url = new URL(raw)
  return `${url.protocol}//${url.host}`
}
