// 附件纯逻辑：格式分类 / 可解析文本判定 / mime 猜测 / 资产引用归一 / 字节 → 规范 base64。
// 只做数据变换，不触 DOM、不触网络；任意格式都接受，可解析文本格式额外内联 `text`。

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Rec = { [key: string]: Json }

const TEXT_MIME = /^text\//

const PARSEABLE_MIME = [
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/csv',
]

const PARSEABLE_EXT = [
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'xml',
  'yaml',
  'yml',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'sql',
  'toml',
  'ini',
  'cfg',
  'conf',
  'log',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'tex',
  'env',
  'gitignore',
]

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tiff']
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg']
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'weba']

const MIME_BY_EXT: { [ext: string]: string } = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
}

export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 扩展名（小写、无点）；无扩展名回空串。 */
export function extensionOf(name: unknown): string {
  if (typeof name !== 'string') return ''
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

/** 是否可解析为内联文本（纯文本 / md / 代码 / json / csv…）。 */
export function isParseable(mime: unknown, name: unknown): boolean {
  if (typeof mime === 'string' && (TEXT_MIME.test(mime) || PARSEABLE_MIME.includes(mime)))
    return true
  return PARSEABLE_EXT.includes(extensionOf(name))
}

/** 附件种类（与消息附件同形）：image / video / audio / file。 */
export function attachmentKind(mime: unknown, name: unknown): string {
  const resolved = typeof mime === 'string' ? mime.toLowerCase() : ''
  if (resolved.startsWith('image/')) return 'image'
  if (resolved.startsWith('video/')) return 'video'
  if (resolved.startsWith('audio/')) return 'audio'
  const ext = extensionOf(name)
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  return 'file'
}

/** 按扩展名猜 mime；未知回 `application/octet-stream`。 */
export function guessMime(name: unknown): string {
  return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream'
}

export interface AssetRef {
  kind: 'asset'
  sha256: string
  mime: string
  size: number
}

/** 归一宿主资产引用（`{kind,sha256,mime,size}`，或包在 `{ref}` 里）；非法回 null。 */
export function normalizeRef(
  ref: unknown,
  fallbackMime: string,
  fallbackSize: number,
): AssetRef | null {
  const value = isRecord(ref) && isRecord(ref.ref) ? ref.ref : ref
  if (!isRecord(value) || typeof value.sha256 !== 'string' || value.sha256.length === 0) return null
  return {
    kind: 'asset',
    sha256: value.sha256,
    mime: typeof value.mime === 'string' && value.mime.length > 0 ? value.mime : fallbackMime,
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : fallbackSize,
  }
}

export interface Attachment {
  kind: string
  name: string
  source: { kind: 'asset'; sha256: unknown; mime: string; size: unknown }
  text?: string
}

export interface AttachmentInput {
  name?: unknown
  mime?: unknown
  sha256?: unknown
  size?: unknown
  text?: unknown
}

/** 构造发送用附件对象：可解析格式带内联 `text`，不可解析只带文件名 + 格式 + 资产引用。 */
export function buildAttachment(input: AttachmentInput): Attachment {
  const { name, mime, sha256, size, text } = input
  const resolvedMime = typeof mime === 'string' && mime.length > 0 ? mime : guessMime(name)
  const attachment: Attachment = {
    kind: attachmentKind(resolvedMime, name),
    name: typeof name === 'string' ? name : '',
    source: { kind: 'asset', sha256, mime: resolvedMime, size },
  }
  if (isParseable(resolvedMime, name) && typeof text === 'string') attachment.text = text
  return attachment
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 字节 → 规范 base64（无 `btoa`，便于 node 下直测）。 */
export function bytesToBase64(bytes: unknown): string {
  const list =
    bytes instanceof Uint8Array
      ? bytes
      : Uint8Array.from((bytes ?? []) as ArrayLike<number>)
  let out = ''
  for (let index = 0; index < list.length; index += 3) {
    const b0 = list[index]
    const has1 = index + 1 < list.length
    const has2 = index + 2 < list.length
    const b1 = has1 ? list[index + 1] : 0
    const b2 = has2 ? list[index + 2] : 0
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]
    out += has1 ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += has2 ? B64_ALPHABET[b2 & 63] : '='
  }
  return out
}
