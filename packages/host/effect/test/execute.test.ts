import { describe, expect, it } from 'vitest'
import { buildAudit, callEffect } from '../execute.ts'
import type { AuditMeta, EndpointCaller, SlotAudit } from '../execute.ts'
import type { AuditDraft } from '../../audit.ts'
import type { EffRequest, EffResult, Json } from '../../../kernel/index.ts'

const NOW = 1000

function meta(overrides: Partial<AuditMeta> = {}): AuditMeta {
  return { by: 'client', now: NOW, ...overrides }
}

function mkEff(port = 'toy.echo', method = 'echo'): EffRequest {
  return { id: 'eff'.repeat(16), port, method, args: null, caps: {} }
}

/** 测试用便捷组合：与生产 run loop 同路，分开调 `callEffect` + `buildAudit`。 */
async function executeEffect(
  eff: EffRequest,
  auditMeta: AuditMeta,
  call?: EndpointCaller,
  signal?: AbortSignal,
): Promise<{ result: EffResult; audit: AuditDraft }> {
  const { result, cancelled } = await callEffect(eff, call, signal)
  return { result, audit: buildAudit(eff, auditMeta, result, cancelled) }
}

/** 审计正文：草稿 body（不进世界，由侧存追加）。 */
function bodyOf(outcome: { audit: { body: Json } }): { [k: string]: Json } {
  return outcome.audit.body as { [k: string]: Json }
}

describe('效果执行（审计草稿）', () => {
  it('无端点调用器 → result.ok=false error=not_loaded，仍产审计草稿', async () => {
    const outcome = await executeEffect(mkEff(), meta())
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toBe('not_loaded')
    expect(outcome.audit.by).toBe('client')
    expect(outcome.audit.at).toBe(NOW)
    expect(bodyOf(outcome)).toMatchObject({ kind: 'effect_audit', outcome: 'transport_failed' })
  })

  it('审计正文含 kind/request/result/port/method/outcome/run/emitter', async () => {
    const eff = mkEff('my.port', 'myMethod')
    const outcome = await executeEffect(eff, meta({ by: 'tester' }))
    expect(bodyOf(outcome)).toEqual({
      kind: 'effect_audit',
      request: eff,
      result: { ok: false, error: 'not_loaded' },
      port: 'my.port',
      method: 'myMethod',
      outcome: 'transport_failed',
      run: null,
      emitter: null,
    })
  })

  it('审计记录 run / emitter（F8 只读面过滤键）', async () => {
    const outcome = await executeEffect(mkEff(), meta({ run: 'run-1', emitter: 'toy-owner' }))
    const body = bodyOf(outcome)
    expect(body['run']).toBe('run-1')
    expect(body['emitter']).toBe('toy-owner')
  })

  it('审计 outcome 机械导出：ok / error / transport_failed', async () => {
    const ok = await executeEffect(mkEff(), meta(), async () => ({ ok: true, value: 1 }))
    expect(bodyOf(ok)['outcome']).toBe('ok')
    const error = await executeEffect(mkEff(), meta(), async () => ({
      ok: true,
      value: { error: 'toy.failed', message: 'boom' },
    }))
    expect(bodyOf(error)['outcome']).toBe('error')
    const transport = await executeEffect(mkEff(), meta(), async () => {
      throw new Error('pipe closed')
    })
    expect(bodyOf(transport)['outcome']).toBe('transport_failed')
  })

  it('取消（signal abort + cancelled 结果）→ outcome=cancelled', async () => {
    const controller = new AbortController()
    const outcome = await executeEffect(
      mkEff(),
      meta(),
      async () => {
        controller.abort()
        return { ok: false, error: 'cancelled' }
      },
      controller.signal,
    )
    expect(outcome.result).toEqual({ ok: false, error: 'cancelled' })
    expect(bodyOf(outcome)['outcome']).toBe('cancelled')
  })

  it('端点有响应（ok:true）→ 值回灌，审计记值', async () => {
    const outcome = await executeEffect(mkEff(), meta(), async () => ({
      ok: true,
      value: { echo: true },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { echo: true } })
    expect(bodyOf(outcome)['result']).toEqual({ ok: true, value: { echo: true } })
  })

  it('端点回 error → ok:true 且 value 是错误描述（数据，term 可分支）', async () => {
    const outcome = await executeEffect(mkEff(), meta(), async () => ({
      ok: true,
      value: { error: 'toy.failed', message: 'boom' },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { error: 'toy.failed', message: 'boom' } })
  })

  it('调用器抛错 → ok:false error=transport_failed', async () => {
    const outcome = await executeEffect(mkEff(), meta(), async () => {
      throw new Error('pipe closed')
    })
    expect(outcome.result).toEqual({ ok: false, error: 'transport_failed' })
  })

  it('host 批量结果超限 → 审计只留截断标记，调用方仍拿完整值', async () => {
    const big = 'x'.repeat(70 * 1024)
    const outcome = await executeEffect(mkEff('host', 'asset.get'), meta(), async () => ({
      ok: true,
      value: { bytes: big },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { bytes: big } })
    expect(bodyOf(outcome)['result']).toEqual({ truncated: true, size: expect.any(Number) })
  })

  it('审计请求 args 超限 → 截断为标记，保留 id/port/method，调用方 args 不变', async () => {
    const big = { text: 'x'.repeat(70 * 1024) }
    const eff: EffRequest = { ...mkEff('toy.echo', 'echo'), args: big }
    const outcome = await executeEffect(eff, meta())
    expect(eff.args).toEqual(big)
    expect(bodyOf(outcome)['request']).toEqual({
      id: eff.id,
      port: 'toy.echo',
      method: 'echo',
      args: { truncated: true, size: expect.any(Number) },
    })
  })

  it('审计请求 args 未超限 → 原样保留（含 caps）', async () => {
    const eff: EffRequest = { ...mkEff('toy.echo', 'echo'), args: { small: true } }
    const outcome = await executeEffect(eff, meta())
    expect(bodyOf(outcome)['request']).toEqual(eff)
  })

  it('任意端口的大结果都截断（审计正文有界，防侧存撑爆）', async () => {
    const big = 'x'.repeat(70 * 1024)
    const outcome = await executeEffect(mkEff('toy.echo', 'echo'), meta(), async () => ({
      ok: true,
      value: { text: big },
    }))
    expect(outcome.result).toEqual({ ok: true, value: { text: big } })
    expect(bodyOf(outcome)['result']).toEqual({ truncated: true, size: expect.any(Number) })
  })
})

describe('效果执行：槽（many）聚合审计', () => {
  function slotBody(audit: AuditDraft): { [k: string]: Json } {
    return audit.body as { [k: string]: Json }
  }

  function auditOf(
    eff: EffRequest,
    slotAudit: SlotAudit,
    cancelled = false,
  ): { result: Json; outcome: Json } {
    const body = slotBody(
      buildAudit(eff, meta(), { ok: true, value: null }, cancelled, undefined, slotAudit),
    )
    return { result: body['result'], outcome: body['outcome'] }
  }

  it('任一元素失败 → outcome=error，逐元素骨架保留', () => {
    const { result, outcome } = auditOf(mkEff(), {
      elements: [
        { provider: 'a', element: { provider: 'a', ok: true, value: 1 } },
        { provider: 'b', element: { provider: 'b', ok: false, error: 'not_loaded' } },
      ],
    })
    expect(outcome).toBe('error')
    expect(result).toEqual([
      { provider: 'a', ok: true, value: 1 },
      { provider: 'b', ok: false, error: 'not_loaded' },
    ])
  })

  it('全元素 ok → outcome=ok；未执行元素（null）省略正文', () => {
    const { result, outcome } = auditOf(mkEff(), {
      elements: [
        { provider: 'a', element: { provider: 'a', ok: true, value: 'a' } },
        { provider: 'b', element: null },
      ],
    })
    expect(outcome).toBe('ok')
    expect(result).toEqual([{ provider: 'a', ok: true, value: 'a' }])
  })

  it('取消 → outcome=cancelled（已执行元素仍保留）', () => {
    const { result, outcome } = auditOf(
      mkEff(),
      { elements: [{ provider: 'a', element: { provider: 'a', ok: false, error: 'cancelled' } }] },
      true,
    )
    expect(outcome).toBe('cancelled')
    expect(result).toEqual([{ provider: 'a', ok: false, error: 'cancelled' }])
  })

  it('逐元素脱敏：按该元素白名单投影 args.auth_ref，替换 value 并派生 has', () => {
    const eff: EffRequest = {
      ...mkEff(),
      args: { auth_ref: { token: 't', other: 'o' } },
    }
    const { result } = auditOf(eff, {
      elements: [
        { provider: 'a', keys: ['token'], element: { provider: 'a', ok: true, value: { raw: 1 } } },
        { provider: 'b', element: { provider: 'b', ok: true, value: { raw: 2 } } },
      ],
    })
    expect(result).toEqual([
      { provider: 'a', ok: true, token: 't', has: true },
      { provider: 'b', ok: true, value: { raw: 2 } },
    ])
  })

  it('单元素超限 → 该元素只留 {provider, ok, value:{truncated,size}}，骨架在', () => {
    const big = 'x'.repeat(70 * 1024)
    const { result } = auditOf(mkEff(), {
      elements: [
        { provider: 'a', element: { provider: 'a', ok: true, value: { text: big } } },
        { provider: 'b', element: { provider: 'b', ok: false, error: 'boom' } },
      ],
    })
    expect(result).toEqual([
      { provider: 'a', ok: true, value: { truncated: true, size: expect.any(Number) } },
      { provider: 'b', ok: false, error: 'boom' },
    ])
  })

  it('N 个大元素各自合规但聚合超预算 → 整槽骨架表 {provider, ok}', () => {
    const chunk = 'x'.repeat(40 * 1024)
    const { result } = auditOf(mkEff(), {
      elements: [
        { provider: 'a', element: { provider: 'a', ok: true, value: { text: chunk } } },
        { provider: 'b', element: { provider: 'b', ok: true, value: { text: chunk } } },
      ],
    })
    expect(result).toEqual({
      truncated: true,
      size: expect.any(Number),
      elements: [
        { provider: 'a', ok: true },
        { provider: 'b', ok: true },
      ],
    })
  })

  it('无 slotAudit 时保持单值口径（outcome 由 deriveOutcome 机械导出）', () => {
    const single = buildAudit(mkEff(), meta(), { ok: true, value: { error: 'toy.failed' } }, false)
    expect(slotBody(single)['outcome']).toBe('error')
    expect(slotBody(single)['result']).toEqual({ ok: true, value: { error: 'toy.failed' } })
  })
})
