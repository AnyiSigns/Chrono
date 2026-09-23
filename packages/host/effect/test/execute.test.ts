import { describe, expect, it } from 'vitest'
import { pos } from '../../../kernel/index.ts'
import { executeEffect } from '../execute.ts'
import type { AuditMeta } from '../execute.ts'
import type { EffRequest, Entry, Hash, Head, Json, World } from '../../../kernel/index.ts'

const EMPTY_HEAD: Head = { seq: -1, hash: null }
const NOW = 1000

function meta(overrides: Partial<AuditMeta> = {}): AuditMeta {
  return { by: 'client', now: NOW, ...overrides }
}

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
    const outcome = await executeEffect(mkEff(), world, head, meta())
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toBe('not_loaded')
    expect(outcome.auditHash).not.toBeNull()
    expect(outcome.auditEntry).not.toBeNull()
    expect(outcome.auditEntry!.op).toBe('put')
    expect(outcome.auditEntry!.by).toBe('client')
    expect(outcome.head.hash).not.toBeNull()
  })

  it('审计 def 的 body 含 kind/request/result/port/method/outcome/run/emitter，ref 留空', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff('my.port', 'myMethod')
    const outcome = await executeEffect(eff, world, head, meta({ by: 'tester' }))
    expect(outcome.auditEntry).not.toBeNull()
    const auditDef = outcome.auditEntry!.args as Record<string, unknown>
    expect(auditDef.body).toEqual({
      kind: 'effect_audit',
      request: eff,
      result: { ok: false, error: 'not_loaded' },
      port: 'my.port',
      method: 'myMethod',
      outcome: 'transport_failed',
      run: null,
      emitter: null,
    })
    expect(outcome.auditEntry!.ref).toBeUndefined()
  })

  it('审计 def 记录 run / emitter（F8 只读面过滤键）', async () => {
    const outcome = await executeEffect(
      mkEff(),
      emptyWorld(),
      { ...EMPTY_HEAD },
      meta({ run: 'run-1', emitter: 'toy-owner' }),
    )
    const body = (outcome.auditEntry!.args as { body: { run: Json; emitter: Json } }).body
    expect(body.run).toBe('run-1')
    expect(body.emitter).toBe('toy-owner')
  })

  it('审计 outcome 机械导出：ok / error / transport_failed', async () => {
    const world = emptyWorld()
    const bodyOf = (outcome: Awaited<ReturnType<typeof executeEffect>>): { outcome: string } =>
      (outcome.auditEntry!.args as { body: { outcome: string } }).body
    const ok = await executeEffect(mkEff(), world, { ...EMPTY_HEAD }, meta(), async () => ({
      ok: true,
      value: 1,
    }))
    expect(bodyOf(ok).outcome).toBe('ok')
    const error = await executeEffect(mkEff(), world, { ...EMPTY_HEAD }, meta(), async () => ({
      ok: true,
      value: { error: 'toy.failed', message: 'boom' },
    }))
    expect(bodyOf(error).outcome).toBe('error')
    const transport = await executeEffect(mkEff(), world, { ...EMPTY_HEAD }, meta(), async () => {
      throw new Error('pipe closed')
    })
    expect(bodyOf(transport).outcome).toBe('transport_failed')
  })

  it('取消（signal abort + cancelled 结果）→ outcome=cancelled', async () => {
    const controller = new AbortController()
    const outcome = await executeEffect(
      mkEff(),
      emptyWorld(),
      { ...EMPTY_HEAD },
      meta(),
      async () => {
        controller.abort()
        return { ok: false, error: 'cancelled' }
      },
      controller.signal,
    )
    expect(outcome.result).toEqual({ ok: false, error: 'cancelled' })
    const body = (outcome.auditEntry!.args as { body: { outcome: string } }).body
    expect(body.outcome).toBe('cancelled')
  })

  it('端点有响应（ok:true）→ 值回灌，审计记值', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff()
    const outcome = await executeEffect(eff, world, head, meta(), async () => ({
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
    const outcome = await executeEffect(mkEff(), world, head, meta(), async () => ({
      ok: true,
      value: { error: 'toy.failed', message: 'boom' },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { error: 'toy.failed', message: 'boom' } })
  })

  it('调用器抛错 → ok:false error=transport_failed', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const outcome = await executeEffect(mkEff(), world, head, meta(), async () => {
      throw new Error('pipe closed')
    })
    expect(outcome.result).toEqual({ ok: false, error: 'transport_failed' })
  })

  it('审计 put 幂等：同 eff 再执行一次，auditEntry 为 null（dup），head 不动', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const eff = mkEff()
    const first = await executeEffect(eff, world, head, meta())
    const second = await executeEffect(eff, first.world, first.head, meta())
    expect(first.auditHash).toBe(second.auditHash)
    expect(second.auditEntry).toBeNull()
    expect(second.head).toEqual(first.head)
  })

  it('审计推进链头：head.hash 从 null 变为 entryHash，且等于该 entry 的位置哈希', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const outcome = await executeEffect(mkEff(), world, head, meta())
    expect(outcome.auditEntry).not.toBeNull()
    expect(outcome.head.hash).toBe(pos([outcome.auditEntry as Entry]))
    expect(outcome.head.seq).toBe(0)
    // 审计时间戳 = 该轮 now（A7）
    expect(outcome.auditEntry?.at).toBe(NOW)
  })

  it('审计 def 键只吃 Def：同一 eff 不同 now 不改变 auditHash', async () => {
    const eff = mkEff()
    const first = await executeEffect(eff, emptyWorld(), { ...EMPTY_HEAD }, meta({ now: 1 }))
    const second = await executeEffect(eff, emptyWorld(), { ...EMPTY_HEAD }, meta({ now: 2 }))
    expect(first.auditHash as Hash).toBe(second.auditHash as Hash)
  })

  it('host 批量结果超限 → 审计只留截断标记，调用方仍拿完整值', async () => {
    const big = 'x'.repeat(70 * 1024)
    const eff = mkEff('host', 'asset.get')
    const outcome = await executeEffect(eff, emptyWorld(), { ...EMPTY_HEAD }, meta(), async () => ({
      ok: true,
      value: { bytes: big },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { bytes: big } })
    const auditBody = (outcome.auditEntry!.args as { body: { result: Json } }).body
    expect(auditBody.result).toEqual({ truncated: true, size: expect.any(Number) })
  })

  it('审计请求 args 超限 → 截断为标记，保留 id/port/method，调用方 args 不变', async () => {
    const big = { text: 'x'.repeat(70 * 1024) }
    const eff: EffRequest = { ...mkEff('toy.echo', 'echo'), args: big }
    const outcome = await executeEffect(eff, emptyWorld(), { ...EMPTY_HEAD }, meta())
    expect(eff.args).toEqual(big)
    const request = (outcome.auditEntry!.args as { body: { request: Json } }).body.request
    expect(request).toEqual({
      id: eff.id,
      port: 'toy.echo',
      method: 'echo',
      args: { truncated: true, size: expect.any(Number) },
    })
  })

  it('审计请求 args 未超限 → 原样保留（含 caps）', async () => {
    const eff: EffRequest = { ...mkEff('toy.echo', 'echo'), args: { small: true } }
    const outcome = await executeEffect(eff, emptyWorld(), { ...EMPTY_HEAD }, meta())
    const request = (outcome.auditEntry!.args as { body: { request: Json } }).body.request
    expect(request).toEqual(eff)
  })

  it('非 host 端口的大结果不截断（审计正文保真）', async () => {
    const big = 'x'.repeat(70 * 1024)
    const outcome = await executeEffect(
      mkEff('toy.echo', 'echo'),
      emptyWorld(),
      { ...EMPTY_HEAD },
      meta(),
      async () => ({
        ok: true,
        value: { text: big },
      }),
    )
    const auditBody = (outcome.auditEntry!.args as { body: { result: Json } }).body
    expect(auditBody.result).toEqual({ ok: true, value: { text: big } })
  })
})
