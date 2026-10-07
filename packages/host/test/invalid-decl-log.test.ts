// 声明非法运维日志去重：同一身份同签名只写一次；声明修好后再变坏必须重记。

import { describe, expect, it } from 'vitest'
import { InvalidDeclLog } from '../invalid-decl-log.ts'

describe('InvalidDeclLog', () => {
  it('同身份同签名只写一次；签名变化重写', () => {
    const written: string[] = []
    const log = new InvalidDeclLog((identity, reason) => written.push(`${identity}:${reason}`))
    log.report([{ identity: 'a', reason: 'bad_timeout_ms' }])
    log.report([{ identity: 'a', reason: 'bad_timeout_ms' }])
    expect(written).toEqual(['a:bad_timeout_ms'])
    log.report([
      { identity: 'a', reason: 'bad_timeout_ms' },
      { identity: 'a', reason: 'bad_timeout_key' },
    ])
    expect(written).toEqual(['a:bad_timeout_ms', 'a:bad_timeout_ms', 'a:bad_timeout_key'])
  })

  it('原因集合顺序不同不算变化；身份恢复合法后再次变坏会重记', () => {
    const written: string[] = []
    const log = new InvalidDeclLog((identity, reason) => written.push(`${identity}:${reason}`))
    log.report([
      { identity: 'a', reason: 'bad_timeout_ms' },
      { identity: 'a', reason: 'bad_timeout_key' },
    ])
    log.report([
      { identity: 'a', reason: 'bad_timeout_key' },
      { identity: 'a', reason: 'bad_timeout_ms' },
    ])
    expect(written).toEqual(['a:bad_timeout_ms', 'a:bad_timeout_key'])
    // 声明修好：该身份不再非法 → 清除签名
    log.report([])
    log.report([{ identity: 'a', reason: 'bad_timeout_ms' }])
    expect(written).toEqual(['a:bad_timeout_ms', 'a:bad_timeout_key', 'a:bad_timeout_ms'])
  })

  it('不同身份互不影响', () => {
    const written: string[] = []
    const log = new InvalidDeclLog((identity, reason) => written.push(`${identity}:${reason}`))
    log.report([
      { identity: 'a', reason: 'bad_every_ms' },
      { identity: 'b', reason: 'bad_every_ms' },
    ])
    log.report([{ identity: 'a', reason: 'bad_every_ms' }])
    expect(written).toEqual(['a:bad_every_ms', 'b:bad_every_ms'])
  })
})
