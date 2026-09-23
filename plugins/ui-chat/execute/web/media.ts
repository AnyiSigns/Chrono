// 媒体资产辅助（纯函数）：base64 解码与图片等比装箱。
// 解码用于把 `ctx.asset.get` 的 base64 字节转成 blob URL（比 data URL 省内存、可 revoke）；
// 装箱用于在图片解码前预留精确显示尺寸，消除懒加载解码引起的布局跳动。

/** base64 文本 → 字节数组。非法字符按 0 处理，不抛。 */
export function base64ToBytes(text: unknown): Uint8Array {
  const source = String(text ?? '').replace(/\s+/g, '')
  if (source.length === 0) return new Uint8Array(0)
  const binary = atob(source)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export interface ImageBox {
  w: number
  h: number
}

/**
 * 按上限等比装箱：把 `dims` 缩放到不超过 `maxW × maxH`（只缩不放）。
 * 尺寸非法返回 null（调用方回落 CSS 约束）。
 */
export function fitBox(dims: ImageBox | null, maxW: number, maxH: number): ImageBox | null {
  if (dims === null || dims.w <= 0 || dims.h <= 0) return null
  const scale = Math.min(1, maxW / dims.w, maxH / dims.h)
  return { w: Math.max(1, Math.round(dims.w * scale)), h: Math.max(1, Math.round(dims.h * scale)) }
}
