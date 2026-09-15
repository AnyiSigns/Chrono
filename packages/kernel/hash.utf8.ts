// UTF-8 编码（从 hash.ts 点分段拆出，预算护栏产物）。孤立代理一律拒绝。

import { KernelError } from './types.ts'

/**
 * 把字符串按 UTF-8 编码为字节序列（保留为独立导出以直接测孤立代理边界）。
 * @throws KernelError('lone_surrogate') 未配对的代理码元
 */
export function utf8(s: string): Uint8Array {
  const bytes: number[] = []
  forEachByte(s, (byte) => bytes.push(byte))
  return new Uint8Array(bytes)
}

/** 逐 code unit 增量产出 UTF-8 字节（H 的流式入口就喂它，不物化整条字节数组）。 */
export function forEachByte(s: string, put: (byte: number) => void): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) put(c)
    else if (c < 0x800) {
      put(0xc0 | (c >> 6))
      put(0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new KernelError('lone_surrogate')
      const cp = 0x10000 + (((c - 0xd800) << 10) | (next - 0xdc00))
      i += 1
      put(0xf0 | (cp >> 18))
      put(0x80 | ((cp >> 12) & 0x3f))
      put(0x80 | ((cp >> 6) & 0x3f))
      put(0x80 | (cp & 0x3f))
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new KernelError('lone_surrogate')
    else {
      put(0xe0 | (c >> 12))
      put(0x80 | ((c >> 6) & 0x3f))
      put(0x80 | (c & 0x3f))
    }
  }
}
