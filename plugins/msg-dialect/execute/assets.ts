// 资产内联：上下文投影对二进制附件只产出占位符（`asset:<sha256>` URL 或 `{type:'asset'}` 源），
// 本模块在发请求前经宿主 `host.asset.get` 把占位符换成真实字节（data URL / base64 内容块）。
// 取字节失败、缺失、格式不受支持或超出内联合计时一律**降级为文本引用**，不整轮失败——
// 避免一次坏引用污染整条会话历史。纯遍历 + 注入式取字节回调；不 import 任何插件、不自取时间。

import { isRecord } from 'plugin-sdk'
import type { Json, PortCaller, Rec } from 'plugin-sdk'

/** 取字节结果：mime + 规范 base64。 */
export interface AssetBytes {
  mime: string
  bytes: string
}

/** 注入式取字节：按 sha256 取；缺失 / 失败回 null。 */
export type AssetFetcher = (sha256: string) => Promise<AssetBytes | null>

/** 单请求内联合计上限（解码后字节）：超出者降级文本，避免一次塞爆请求体与计费。 */
export const MAX_TOTAL_ASSET_BYTES = 16 * 1024 * 1024

const ASSET_URL = /^asset:([0-9a-f]{64})$/

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** base64 解码后字节数（规范 base64，无空白）。 */
function decodedSize(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** 从 URL / 值里取资产 sha256；非资产回空串。 */
function shaOf(value: string): string {
  const match = ASSET_URL.exec(value)
  return match === null ? '' : match[1]
}

function asAsset(value: unknown): { sha256: string; mime: string } | null {
  if (!isRecord(value)) return null
  const sha256 = asString(value['sha256'])
  if (sha256 === null) return null
  return { sha256, mime: asString(value['mime']) ?? 'application/octet-stream' }
}

/** openai 音频入参格式词表；不受支持回 null。 */
function audioFormat(mime: string): string | null {
  const value = mime.toLowerCase()
  if (value === 'audio/wav' || value === 'audio/x-wav' || value === 'audio/wave') return 'wav'
  if (value === 'audio/mpeg' || value === 'audio/mp3') return 'mp3'
  return null
}

/** 降级文本引用（与 context-window 的 modality_fallback 同语义，名称缺失时用 sha 前 8 位）。 */
function referenceText(kind: string, mime: string, sha: string): string {
  const name = sha.length > 0 ? sha.slice(0, 8) : kind
  return `[${kind} 附件：${name}（${mime}）]`
}

/** 宿主取字节回调：`host.asset.get`；端口不可用 / 缺失 / 非法一律回 null。 */
export function createHostFetcher(host: PortCaller): AssetFetcher {
  return async (sha256) => {
    const outcome = await host.call('host', 'asset.get', { sha256 })
    if (!outcome.ok || !isRecord(outcome.value)) return null
    const mime = asString(outcome.value['mime'])
    const bytes = typeof outcome.value['bytes'] === 'string' ? outcome.value['bytes'] : null
    if (mime === null || bytes === null) return null
    return { mime, bytes }
  }
}

/** 单次请求的内联器：按 sha 缓存取字节结果，并累计总量配额。 */
class Resolver {
  private readonly cache = new Map<string, AssetBytes | null>()
  private readonly protocol: string
  private readonly fetchAsset: AssetFetcher
  private used = 0

  constructor(protocol: string, fetchAsset: AssetFetcher) {
    this.protocol = protocol
    this.fetchAsset = fetchAsset
  }

  async resolve(messages: Json[]): Promise<Json[]> {
    const out: Json[] = []
    for (const message of messages) {
      if (!isRecord(message)) {
        out.push(message)
        continue
      }
      const role = asString(message['role']) ?? 'user'
      const content = message['content']
      if (Array.isArray(content)) {
        const parts: Json[] = []
        for (const part of content) parts.push(await this.part(part, role))
        out.push({ ...message, content: parts })
        continue
      }
      if (typeof content === 'string') {
        const rewritten = await this.rewriteUrl(content)
        out.push(rewritten === content ? message : { ...message, content: rewritten })
        continue
      }
      out.push(message)
    }
    return out
  }

  private async part(part: Json, role: string): Promise<Json> {
    if (!isRecord(part)) return part
    const type = asString(part['type'])
    if (type === null) return part
    if (this.protocol === 'anthropic-messages') return this.anthropicPart(part, type, role)
    if (this.protocol === 'openai-responses') return this.responsesPart(part, type, role)
    return this.chatPart(part, type, role)
  }

  private async chatPart(part: Rec, type: string, role: string): Promise<Json> {
    if (type === 'image_url') {
      const imageUrl = isRecord(part['image_url']) ? (part['image_url'] as Rec) : null
      const url = imageUrl === null ? null : asString(imageUrl['url'])
      if (url === null) return part
      const rewritten = await this.rewriteUrl(url)
      if (rewritten === url) return part
      if (rewritten === null) return this.fallback(role, 'image', 'image/*', shaOf(url))
      return { ...part, image_url: { ...imageUrl, url: rewritten } }
    }
    if (type === 'input_audio') {
      const audio = isRecord(part['input_audio']) ? (part['input_audio'] as Rec) : null
      const asset = audio === null ? null : asAsset(audio['asset'])
      if (asset === null) return part
      const fetched = await this.take(asset.sha256)
      if (fetched === null) return this.fallback(role, 'audio', asset.mime, asset.sha256)
      const format = audioFormat(fetched.mime)
      if (format === null) return this.fallback(role, 'audio', fetched.mime, asset.sha256)
      return { ...part, input_audio: { data: fetched.bytes, format } }
    }
    if (type === 'file') {
      const file = isRecord(part['file']) ? (part['file'] as Rec) : null
      const asset = file === null ? null : asAsset(file['asset'])
      if (asset === null) return part
      // chat completions 无通用文件 content part ⇒ 降级文本引用
      return this.fallback(role, 'file', asset.mime, asset.sha256)
    }
    return part
  }

  private async responsesPart(part: Rec, type: string, role: string): Promise<Json> {
    if (type === 'input_image') {
      const url = asString(part['image_url'])
      if (url === null) return part
      const rewritten = await this.rewriteUrl(url)
      if (rewritten === url) return part
      if (rewritten === null) return this.fallback(role, 'image', 'image/*', shaOf(url))
      return { ...part, image_url: rewritten }
    }
    if (type === 'input_audio') {
      const audio = isRecord(part['input_audio']) ? (part['input_audio'] as Rec) : null
      const asset = audio === null ? null : asAsset(audio['asset'])
      if (asset === null) return part
      const fetched = await this.take(asset.sha256)
      if (fetched === null) return this.fallback(role, 'audio', asset.mime, asset.sha256)
      const format = audioFormat(fetched.mime)
      if (format === null) return this.fallback(role, 'audio', fetched.mime, asset.sha256)
      return { ...part, input_audio: { data: fetched.bytes, format } }
    }
    if (type === 'input_file') {
      const file = isRecord(part['file']) ? (part['file'] as Rec) : null
      const asset = file === null ? null : asAsset(file['asset'])
      if (asset === null) return part
      const fetched = await this.take(asset.sha256)
      if (fetched === null) return this.fallback(role, 'file', asset.mime, asset.sha256)
      const filename = (file !== null ? asString(file['name']) : null) ?? asset.sha256.slice(0, 8)
      return { type: 'input_file', file_data: this.dataUrl(fetched), filename }
    }
    return part
  }

  private async anthropicPart(part: Rec, type: string, role: string): Promise<Json> {
    const source = isRecord(part['source']) ? (part['source'] as Rec) : null
    if (source === null || source['type'] !== 'asset') return part
    const asset = asAsset(source)
    if (asset === null) return part
    if (type === 'image' || type === 'document') {
      const fetched = await this.take(asset.sha256)
      if (fetched === null) return this.fallback(role, type, asset.mime, asset.sha256)
      return { type, source: { type: 'base64', media_type: fetched.mime, data: fetched.bytes } }
    }
    // anthropic 无 audio / video / 通用 file 入参 ⇒ 降级文本引用
    return this.fallback(role, type, asset.mime, asset.sha256)
  }

  private textType(role: string): string {
    if (this.protocol !== 'openai-responses') return 'text'
    return role === 'assistant' ? 'output_text' : 'input_text'
  }

  private fallback(role: string, kind: string, mime: string, sha: string): Json {
    return {
      type: this.textType(role),
      text: referenceText(kind, mime.length > 0 ? mime : 'unknown', sha),
    }
  }

  private dataUrl(bytes: AssetBytes): string {
    return `data:${bytes.mime};base64,${bytes.bytes}`
  }

  /** 非资产 URL 原样返回；资产命中回 data URL；取字节失败 / 超限回 null（调用方降级）。 */
  private async rewriteUrl(url: string): Promise<string | null> {
    const match = ASSET_URL.exec(url)
    if (match === null) return url
    const fetched = await this.take(match[1])
    return fetched === null ? null : this.dataUrl(fetched)
  }

  /** 取字节并计入总量配额；缺失 / 超限回 null。 */
  private async take(sha256: string): Promise<AssetBytes | null> {
    let bytes = this.cache.get(sha256)
    if (bytes === undefined) {
      bytes = await this.fetchAsset(sha256)
      this.cache.set(sha256, bytes)
    }
    if (bytes === null) return null
    const size = decodedSize(bytes.bytes)
    if (this.used + size > MAX_TOTAL_ASSET_BYTES) return null
    this.used += size
    return bytes
  }
}

/** 把消息里所有资产占位符内联为真实字节；失败 / 超限降级文本引用。 */
export function resolveAssets(
  messages: Json[],
  protocol: string,
  fetchAsset: AssetFetcher,
): Promise<Json[]> {
  return new Resolver(protocol, fetchAsset).resolve(messages)
}
