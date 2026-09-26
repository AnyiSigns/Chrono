import { describe, expect, it } from 'vitest'
import {
  isSafeIdentityName,
  isSafePackageFilePath,
  isSafeRelativePath,
  normalizeRefPath,
  pathSegments,
} from '../paths-safe.ts'

describe('common/paths-safe · 身份名', () => {
  it('接受常规单段名', () => {
    for (const id of ['toy', 'tool-fs', 'toy_alpha', 'A1']) {
      expect(isSafeIdentityName(id)).toBe(true)
    }
  })

  it('拒绝路径穿越 / 分隔符 / 盘符', () => {
    for (const id of ['a/b', 'a\\b', '../x', '..', '.', 'C:x', 'C:\\x']) {
      expect(isSafeIdentityName(id)).toBe(false)
    }
  })

  it('拒绝 JS 原型键（world.ids 是普通对象，继承成员会误判为已存在）', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect(isSafeIdentityName(id)).toBe(false)
    }
  })

  it('拒绝 Windows 非法名与保留设备名', () => {
    for (const id of ['x:y', 'x?y', 'x*y', 'x.', 'x ', 'CON', 'com1', 'LPT9.txt']) {
      expect(isSafeIdentityName(id)).toBe(false)
    }
  })

  it('拒绝保留身份名 host 与超长 / 空名', () => {
    expect(isSafeIdentityName('host')).toBe(false)
    expect(isSafeIdentityName('')).toBe(false)
    expect(isSafeIdentityName('a'.repeat(129))).toBe(false)
  })
})

describe('common/paths-safe · 相对路径', () => {
  it('isSafeRelativePath 拒绝逃逸，放行常规相对路径', () => {
    expect(isSafeRelativePath('terms/foo.json')).toBe(true)
    expect(isSafeRelativePath('./terms/foo.json')).toBe(true)
    expect(isSafeRelativePath('')).toBe(false)
    expect(isSafeRelativePath('/abs')).toBe(false)
    expect(isSafeRelativePath('a\\b')).toBe(false)
    expect(isSafeRelativePath('C:x')).toBe(false)
    expect(isSafeRelativePath('a/../b')).toBe(false)
  })

  it('isSafePackageFilePath 逐段拒绝空段 / . / .. / Windows 非法名', () => {
    expect(isSafePackageFilePath('terms/foo.json')).toBe(true)
    expect(isSafePackageFilePath('')).toBe(false)
    expect(isSafePackageFilePath('a//b')).toBe(false)
    expect(isSafePackageFilePath('./a')).toBe(false)
    expect(isSafePackageFilePath('a/../b')).toBe(false)
    expect(isSafePackageFilePath('a<b')).toBe(false)
    expect(isSafePackageFilePath('con')).toBe(false)
    expect(isSafePackageFilePath('a.')).toBe(false)
  })

  it('pathSegments 丢弃空段 / `.`，`..` 返回 null', () => {
    expect(pathSegments('a//b/./c')).toEqual(['a', 'b', 'c'])
    expect(pathSegments('a/../b')).toBeNull()
  })

  it('normalizeRefPath 规范化引用路径，空 / 逃逸返回 null', () => {
    expect(normalizeRefPath('./terms/foo.json')).toBe('terms/foo.json')
    expect(normalizeRefPath('')).toBeNull()
    expect(normalizeRefPath('a/../b')).toBeNull()
  })
})
