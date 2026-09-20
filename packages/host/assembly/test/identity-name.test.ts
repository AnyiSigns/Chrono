import { describe, expect, it } from 'vitest'
import { isSafeIdentityName } from '../identity-name.ts'

describe('身份名安全约束', () => {
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
