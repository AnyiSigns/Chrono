import { describe, expect, it } from 'vitest'
import { casFilePath, decodeBase64Strict, isSha256Hex } from '../cas.ts'

describe('common/cas', () => {
  it('isSha256Hex 只认 64 位小写十六进制', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true)
    expect(isSha256Hex('A'.repeat(64))).toBe(false)
    expect(isSha256Hex('a'.repeat(63))).toBe(false)
    expect(isSha256Hex('g'.repeat(64))).toBe(false)
    expect(isSha256Hex(123)).toBe(false)
  })

  it('casFilePath 非 64-hex 返回 null（防路径穿越）', () => {
    expect(casFilePath('/tmp', '../escape')).toBeNull()
    expect(casFilePath('/tmp', 'A'.repeat(64))).toBeNull()
    expect(casFilePath('/tmp', 'a'.repeat(64))).not.toBeNull()
  })

  it('decodeBase64Strict 只收规范往返编码', () => {
    expect(decodeBase64Strict(Buffer.from('abc').toString('base64'))?.toString()).toBe('abc')
    expect(decodeBase64Strict('YWJj')?.toString()).toBe('abc')
    expect(decodeBase64Strict('!!!not-base64!!!')).toBeNull()
  })
})
