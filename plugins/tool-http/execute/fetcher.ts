// fetcher 命令契约：本插件把抓取意图映射为 fetcher 参数，网络出口统一经隔离执行跑它。
// stdout 首行是元数据 JSON（status / content_type / url / truncated / body_encoding），
// 其余是 base64 响应体；stderr 是错误文本。响应体 base64 化以便二进制安全穿越协议帧。
// 缺省用本包内置的 Node fetcher（零运行前置）；配置 `fetcher_cmd` 非空时改用外部命令（沙箱镜像提供）。

import { fileURLToPath } from 'node:url'
import { isRec } from './types.ts'

export interface FetchSpec {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  timeoutMs: number
  maxSize: number
  maxRedirs: number
}

/** 命令与参数前缀：`cmd` + `prefix` 是固定部分，逐次抓取参数追加在后。 */
export interface FetcherCommand {
  cmd: string
  prefix: string[]
}

/** 本包内置 fetcher 脚本绝对路径（随 `execute/` 入世、物化后可读）。 */
const BUNDLED_FETCHER_PATH = fileURLToPath(new URL('./fetcher-cli.mjs', import.meta.url))

/**
 * 解析 fetcher 命令：`fetcher_cmd` 非空 = 外部命令（沙箱镜像提供），原样作 `cmd`；
 * 空 = 内置 Node fetcher，用当前 Node 可执行文件跑本包脚本。
 */
export function resolveFetcherCommand(fetcherCmd: string): FetcherCommand {
  const external = typeof fetcherCmd === 'string' ? fetcherCmd.trim() : ''
  if (external.length > 0) return { cmd: external, prefix: [] }
  return { cmd: process.execPath, prefix: [BUNDLED_FETCHER_PATH] }
}

/** 构造 fetcher 的命令与参数（`prefix` 为命令自身参数，缺省无）。 */
export function buildFetcherCommand(
  cmd: string,
  spec: FetchSpec,
  prefix: string[] = [],
): { cmd: string; args: string[] } {
  const args = [...prefix, '--url', spec.url, '--method', spec.method]
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
