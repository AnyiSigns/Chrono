// 标题后处理与兜底（纯函数，同输入同输出、不取时间 / 随机）。
// 模型输出先清理（取首个非空行、去首尾空白 / 引号 / 换行 / 结尾标点），再按 Unicode 码点硬截断；
// 模型失败 / 超时 / 空时回落首条用户消息去空白后的前 N 字，仍空回落调用方给的缺省标题。

const WRAPPING_QUOTES = new Set(['"', "'", '`', '“', '”', '‘', '’', '「', '」', '『', '』', '《', '》'])

const TRAILING_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?', '~',
  '。', '，', '；', '：', '！', '？', '、', '…', '·', '—', '～',
])

/** 折叠空白并去首尾。 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 按 Unicode 码点截断（CJK 每字算 1，不劈代理对）。 */
export function truncateCodePoints(value: string, maxChars: number): string {
  const points = Array.from(value)
  if (points.length <= maxChars) return value
  return points.slice(0, maxChars).join('')
}

/** 去掉首尾成对引号（可重复），再清掉单侧残留引号。 */
function stripWrappingQuotes(value: string): string {
  let text = value.trim()
  while (text.length >= 2 && WRAPPING_QUOTES.has(text[0]) && WRAPPING_QUOTES.has(text[text.length - 1])) {
    text = text.slice(1, -1).trim()
  }
  while (text.length > 0 && WRAPPING_QUOTES.has(text[0])) text = text.slice(1).trim()
  while (text.length > 0 && WRAPPING_QUOTES.has(text[text.length - 1])) text = text.slice(0, -1).trim()
  return text
}

function stripTrailingPunctuation(value: string): string {
  let text = value
  while (text.length > 0 && (TRAILING_PUNCTUATION.has(text[text.length - 1]) || WRAPPING_QUOTES.has(text[text.length - 1]))) {
    text = text.slice(0, -1)
  }
  return text.trim()
}

/** 模型输出清理：取首个非空行 → 去引号 → 按码点截断 → 去结尾标点与残留空白。 */
export function cleanModelTitle(raw: string, maxChars: number): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  return stripTrailingPunctuation(truncateCodePoints(stripWrappingQuotes(firstLine), maxChars))
}

/** 兜底标题：首条用户消息去空白后按码点取前 maxChars 字。 */
export function fallbackTitle(firstMessage: string, maxChars: number): string {
  return truncateCodePoints(normalizeWhitespace(firstMessage), maxChars)
}

/**
 * 兜底顺序：模型清理结果 → 首条消息前 N 字 → 调用方缺省标题。
 * `titleDefault` 由调用方保证非空（本插件不内置标题文案）。
 */
export function resolveTitle(modelText: string | null, firstMessage: string, maxChars: number, titleDefault: string): string {
  const cleaned = modelText === null ? '' : cleanModelTitle(modelText, maxChars)
  if (cleaned.length > 0) return cleaned
  const fallback = fallbackTitle(firstMessage, maxChars)
  if (fallback.length > 0) return fallback
  return titleDefault
}
