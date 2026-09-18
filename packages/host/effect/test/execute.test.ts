import { describe, expect, it } from 'vitest'
import { pos } from '../../../kernel/index.ts'
import { executeEffect } from '../execute.ts'
import type { EffRequest, Entry, Hash, Head, Json, World } from '../../../kernel/index.ts'

const EMPTY_HEAD: Head = { seq: -1, hash: null }
const NOW = 1000

function mkEff(port = 'toy.echo', method = 'echo'): EffRequest {
  return { id: 'eff'.repeat(16), port, method, args: null, caps: {} }
}

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

describe('效果执行 executeEffect', () => {
  it('无端点调用器 → result.ok=false error=not_loaded，审计 def 落链', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const outcome = await executeEffect(mkEff(), world, head, 'client', NOW)
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toBe('not_loaded')
    expect(outcome.auditHash).not.toBeNull()
    expect(outcome.auditEntry).not.toBeNull()
    expect(outcome.auditEntry!.op).toBe('put')
    expect(outcome.auditEntry!.by).toBe('client')
    expect(outcome.head.hash).not.toBeNull()
  })

  it('审计 def 的 body 包含 request/result/port/method，ref 留空', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff('my.port', 'myMethod')
    const outcome = await executeEffect(eff, world, head, 'tester', NOW)
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

  it('端点有响应（ok:true）→ 值回灌，审计记值', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff()
    const outcome = await executeEffect(eff, world, head, 'client', NOW, async () => ({
      ok: true,
      value: { echo: true },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { echo: true } })
    const auditBody = (outcome.auditEntry!.args as { body: { result: Json } }).body
    expect(auditBody.result).toEqual({ ok: true, value: { echo: true } })
  })

  it('端点回 error → ok:true 且 value 是错误描述（数据，term 可分支）', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const outcome = await executeEffect(mkEff(), world, head, 'client', NOW, async () => ({
      ok: true,
      value: { error: 'toy.failed', message: 'boom' },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { error: 'toy.failed', message: 'boom' } })
  })

  it('调用器抛错 → ok:false error=transport_failed', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const outcome = await executeEffect(mkEff(), world, head, 'client', NOW, async () => {
      throw new Error('pipe closed')
    })
    expect(outcome.result).toEqual({ ok: false, error: 'transport_failed' })
  })

  it('审计 put 幂等：同 eff 再执行一次，auditEntry 为 null（dup），head 不动', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff()
    const first = await executeEffect(eff, world, head, 'client', NOW)
    const second = await executeEffect(eff, first.world, first.head, 'client', NOW)
    expect(first.auditHash).toBe(second.auditHash)
    expect(second.auditEntry).toBeNull()
    expect(second.head).toEqual(first.head)
  })

  it('审计推进链头：head.hash 从 null 变为 entryHash，且等于该 entry 的位置哈希', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const outcome = await executeEffect(mkEff(), world, head, 'client', NOW)
    expect(outcome.auditEntry).not.toBeNull()
    expect(outcome.head.hash).toBe(pos([outcome.auditEntry as Entry]))
    expect(outcome.head.seq).toBe(0)
    // 审计时间戳 = 该轮 now（A7）
    expect(outcome.auditEntry?.at).toBe(NOW)
  })

  it('审计 def 键只吃 Def：同一 eff 不同 now 不改变 auditHash', async () => {
    const eff = mkEff()
    const first = await executeEffect(eff, emptyWorld(), { ...EMPTY_HEAD }, 'client', 1)
    const second = await executeEffect(eff, emptyWorld(), { ...EMPTY_HEAD }, 'client', 2)
    expect(first.auditHash as Hash).toBe(second.auditHash as Hash)
  })
})
