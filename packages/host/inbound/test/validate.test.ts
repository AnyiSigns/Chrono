// 入站消息与 directive 草稿的形状校验：畸形提交一律拒（返回 null），不得打崩写者。

import { describe, expect, it } from 'vitest'
import { asDirectives, readMessage } from '../validate.ts'

describe('inbound/validate', () => {
  it('readMessage：v / id / kind 皆字符串才认', () => {
    expect(readMessage({ v: '1', id: 'a', kind: 'status' })).not.toBeNull()
    expect(readMessage({ v: '1', id: 'a' })).toBeNull()
    expect(readMessage({ v: 1, id: 'a', kind: 'status' })).toBeNull()
    expect(readMessage('not-an-object')).toBeNull()
    expect(readMessage(null)).toBeNull()
  })

  it('asDirectives：eval / extern / write 合法', () => {
    expect(asDirectives([{ kind: 'eval', entry: 'h' }])).not.toBeNull()
    expect(asDirectives([{ kind: 'extern', payload: null }])).not.toBeNull()
    expect(asDirectives([{ kind: 'write', request: { op: 'put', args: {} } }])).not.toBeNull()
  })

  it('asDirectives：未知 kind / 缺 entry / 坏 op / 非数组 一律拒', () => {
    expect(asDirectives([{ kind: 'unknown' }])).toBeNull()
    expect(asDirectives([{ kind: 'eval', entry: '' }])).toBeNull()
    expect(asDirectives([{ kind: 'write', request: { op: 'nope' } }])).toBeNull()
    expect(asDirectives([{ kind: 'write', request: null }])).toBeNull()
    expect(asDirectives('nope')).toBeNull()
  })
})
