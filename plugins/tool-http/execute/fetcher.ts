// fetcher 命令契约：本插件把抓取意图映射为 fetcher 参数，网络出口统一经隔离执行跑它。
// stdout 首行是元数据 JSON（status / content_type / url / truncated / body_encoding），
// 其余是 base64 响应体；stderr 是错误文本。响应体 base64 化以便二进制安全穿越协议帧。

import { isRec } from './types.ts'

export interface FetchSpec {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  timeoutMs: number
  maxSize: number
  maxRedirs: number
}

/** 构造 fetcher 的命令与参数。 */
export function buildFetcherCommand(
  cmd: string,
  spec: FetchSpec,
): { cmd: string; args: string[] } {
  const args = ['--url', spec.url, '--method', spec.method]
  for (const [key, value] of Object.entries(spec.headers)) args.push('--header', `${key}: ${value}`)
  args.push('--timeout', String(spec.timeoutMs))
  args.push('--max-size', String(spec.maxSize))
  args.push('--max-redirs', String(spec.maxRedirs))
  args.push('--meta')
  return { cmd, args }
}

export interface FetcherOutput {
  status: number
  contentType: string
  url: string
  truncated: boolean
  bytes: Buffer
}

/** 解析 fetcher stdout；元数据缺失 / 编码未知 / base64 非法返回 null。 */
export function parseFetcherStdout(stdout: string): FetcherOutput | null {
  const newline = stdout.indexOf('\n')
  const metaLine = newline === -1 ? stdout : stdout.slice(0, newline)
  const bodyText = newline === -1 ? '' : stdout.slice(newline + 1)
  let meta: unknown
  try {
    meta = JSON.parse(metaLine)
  } catch {
    return null
  }
  if (!isRec(meta) || meta['body_encoding'] !== 'base64') return null
  const status = meta['status']
  if (typeof status !== 'number' || !Number.isFinite(status)) return null
  const compact = bodyText.replace(/\s+/g, '')
  if (compact.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null
  return {
    status: Math.trunc(status),
    contentType: typeof meta['content_type'] === 'string' ? meta['content_type'] : '',
    url: typeof meta['url'] === 'string' ? meta['url'] : '',
    truncated: meta['truncated'] === true,
    bytes: Buffer.from(compact, 'base64'),
  }
}
