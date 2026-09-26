// `host.source.read` 回包的解析：宿主回 `{path, content(base64), size}`，形态不符回落 null。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

/** 读插件源码 blob（base64 文本）；形态不符回落 null。 */
export function decodeSourceRead(
  value: Json,
): { path: string; text: string; size: number } | null {
  if (!isRecord(value)) return null
  const path = value['path']
  const content = value['content']
  if (typeof path !== 'string' || typeof content !== 'string') return null
  const size = typeof value['size'] === 'number' ? value['size'] : 0
  try {
    return { path, text: Buffer.from(content, 'base64').toString('utf8'), size }
  } catch {
    return null
  }
}
