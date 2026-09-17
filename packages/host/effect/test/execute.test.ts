import { describe, expect, it } from 'vitest'
import { executeEffect } from '../execute.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Hash = string
type Head = { seq: number; hash: Hash | null }

const EMPTY_HEAD: Head = { seq: -1, hash: null }
const NOW = 1000

function mkEff(port = 'toy.echo', method = 'echo') {
  return { id: 'eff'.repeat(16), port, method, args: null, caps: {} } as { id: Hash; port: string; method: string; args: Json; caps: Record<string, boolean> }
}

describe('效果执行 executeEffect', () => {
  it('未解析端点 → result.ok=false error=not_loaded，审计 def 落链', () => {
    const world = { defs: {}, ids: {} }
    const head: Head = { ...EMPTY_HEAD }
    const outcome = executeEffect(mkEff(), world as any, head, 'client', NOW)
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toBe('not_loaded')
    expect(outcome.auditHash).not.toBeNull()
    expect(outcome.auditEntry).not.toBeNull()
    expect(outcome.auditEntry!.op).toBe('put')
    expect(outcome.auditEntry!.by).toBe('client')
    expect(outcome.head.hash).not.toBeNull()
  })

  it('审计 def 的 body 包含 request/result/port/method，ref 留空', () => {
    const world = { defs: {}, ids: {} }
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff('my.port', 'myMethod')
    const outcome = executeEffect(eff, world as any, head, 'tester', NOW)
    expect(outcome.auditEntry).not.toBeNull()
    const auditDef = outcome.auditEntry!.args as Record<string, unknown>
    expect(auditDef.body).toEqual({
      request: eff,
      result: { ok: false, error: 'not_loaded' },
      port: 'my.port',
      method: 'myMethod',
    })
    expect(outcome.auditEntry!.ref).toBeUndefined()
  })

  it('审计 put 幂等：同 eff 再执行一次，auditEntry 为 null（dup），auditHash 不变', () => {
    const world = { defs: {}, ids: {} }
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff()
    const first = executeEffect(eff, world as any, head, 'client', NOW)
    const second = executeEffect(eff, first.world, first.head, 'client', NOW)
    expect(first.auditHash).toBe(second.auditHash)
    expect(second.auditEntry).toBeNull()
  })

  it('审计推进链头：head.hash 从 null 变为 entryHash', () => {
    const world = { defs: {}, ids: {} }
    const head: Head = { ...EMPTY_HEAD }
    const outcome = executeEffect(mkEff(), world as any, head, 'client', NOW)
    expect(outcome.head.hash).not.toBeNull()
    expect(outcome.head.seq).toBe(0)
  })
})
