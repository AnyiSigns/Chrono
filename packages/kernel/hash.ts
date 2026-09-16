// 内容哈希（地基）：FIPS 180-4 sha256 + H()；utf8 拆分在 hash.utf8.ts。
// H 走增量压缩：canonical 字符流按 code unit 喂入，凑满 512 位块就地压缩，
// 不物化整条字节数组。零第三方 import。

import { canonicalJson } from './value.ts'
import { forEachByte } from './hash.utf8.ts'
import type { Hash, Json } from './types.ts'

/**
 * 字符串按 UTF-8 编码为字节序列（点分段在 hash.utf8.ts，此处转口以直接测孤立代理边界）。
 * @param s 待编码字符串
 * @returns UTF-8 字节
 * @throws KernelError('lone_surrogate') 未配对的代理码元
 */
export { utf8 } from './hash.utf8.ts'

/** 初始哈希值：前 8 个素数平方根小数部分的前 32 位。冻结只读；newState 取切片。 */
const IV = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

/** K 常数表：前 64 个素数立方根小数部分的前 32 位，按  全表以 hex 串存储。 */
const K_HEX =
  '428a2f9871374491b5c0fbcfe9b5dba5' +
  '3956c25b59f111f1923f82a4ab1c5ed5d807aa9812835b01243185be550c7dc3' +
  '72be5d7480deb1fe9bdc06a7c19bf174e49b69c1efbe47860fc19dc6240ca1cc' +
  '2de92c6f4a7484aa5cb0a9dc76f988da983e5152a831c66db00327c8bf597fc7' +
  'c6e00bf3d5a7914706ca63511429296727b70a852e1b21384d2c6dfc53380d13' +
  '650a7354766a0abb81c2c92e92722c85a2bfe8a1a81a664bc24b8b70c76c51a3' +
  'd192e819d6990624f40e3585106aa07019a4c1161e376c082748774c34b0bcb5' +
  '391c0cb34ed8aa4a5b9cca4f682e6ff3748f82ee78a5636f84c878148cc70208' +
  '90befffa' +
  'a4506ceb' +
  'bef9a3f7' +
  'c67178f2'

const K: number[] = []
for (let i = 0; i < K_HEX.length; i += 8) K.push(parseInt(K_HEX.slice(i, i + 8), 16) >>> 0)
Object.freeze(K)

function rot(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

interface Sha256State {
  h: number[]
  buf: Uint8Array
  used: number
  total: number
  w: number[]
}

function newState(): Sha256State {
  return { h: IV.slice(), buf: new Uint8Array(64), used: 0, total: 0, w: new Array(64) }
}

function compress(st: Sha256State, off: number): void {
  const { buf, w } = st
  for (let i = 0; i < 16; i++) {
    const p = off + i * 4
    w[i] = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15]
    const y = w[i - 2]
    const s0 = (rot(x, 7) ^ rot(x, 18) ^ (x >>> 3)) >>> 0
    const s1 = (rot(y, 17) ^ rot(y, 19) ^ (y >>> 10)) >>> 0
    w[i] = (((w[i - 16] + s0) >>> 0) + ((w[i - 7] + s1) >>> 0)) >>> 0
  }
  let [a, b, c, d, e, f, g, h] = st.h
  for (let i = 0; i < 64; i++) {
    const S1 = (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) >>> 0
    const ch = ((e & f) ^ (~e & g)) >>> 0
    const t1 = (((h + S1) >>> 0) + ((ch + K[i]) >>> 0) + w[i]) >>> 0
    const S0 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) >>> 0
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
    const t2 = (S0 + maj) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  const sum = [a, b, c, d, e, f, g, h]
  for (let i = 0; i < 8; i++) st.h[i] = (st.h[i] + sum[i]) >>> 0
}

function pushByte(st: Sha256State, byte: number): void {
  st.buf[st.used] = byte
  st.used += 1
  st.total += 1
  if (st.used === 64) {
    compress(st, 0)
    st.used = 0
  }
}

function finish(st: Sha256State): Uint8Array {
  const bitLenBytes = st.total
  pushByte(st, 0x80)
  // 补 0 至 len ≡ 56 (mod 64)，再追加 64 位大端 bit 长度（pad）
  while (st.used !== 56) pushByte(st, 0)
  const hi = Math.floor(bitLenBytes / 2 ** 29)
  const lo = (bitLenBytes % 2 ** 29) * 8
  const tail = [hi >>> 24, hi >>> 16, hi >>> 8, hi, lo >>> 24, lo >>> 16, lo >>> 8, lo]
  for (const byte of tail) pushByte(st, byte & 0xff)
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    out[i * 4] = st.h[i] >>> 24
    out[i * 4 + 1] = (st.h[i] >>> 16) & 0xff
    out[i * 4 + 2] = (st.h[i] >>> 8) & 0xff
    out[i * 4 + 3] = st.h[i] & 0xff
  }
  return out
}

/**
 * 对整段字节做 sha256（规格的自证哈希向量用它直接断言；H 走增量入口，不走这里）。
 * @param bytes 完整输入缓冲
 * @returns 32 字节摘要
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  const st = newState()
  for (const byte of bytes) pushByte(st, byte)
  return finish(st)
}

/**
 * 内容哈希：hex(sha256(utf8(canonicalJson(v))))，全 64 个十六进制字符，不截断。
 * @param v 参与哈希的任意 JSON 值
 * @returns 64 位 hex 摘要
 * @throws KernelError canonicalJson 的口径（'undefined' / 'nonfinite' / 'depth'）
 *   与编码边界（'lone_surrogate'，正常经 canonicalJson 不会触发，防旁路输入）
 */
export function H(v: Json | undefined): Hash {
  const st = newState()
  forEachByte(canonicalJson(v), (byte) => pushByte(st, byte))
  return toHex(finish(st))
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
