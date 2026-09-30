// 判定内效果的取消口径（F-27）：与 run-loop 的 `callEffect`（execute.ts）对齐——仅
// 「已中止 且 结果就是 cancelled 通道错误」记取消；超时 / 其它通道错误即便外层已中止也不误记；
// 未中止时通道报 cancelled 同样不记取消。

import { describe, expect, it } from 'vitest'
import { ServiceChannelError } from '../../service-link.ts'
import { EMPTY_WORLD } from '../../../kernel/index.ts'
import { createJudgmentInvoke } from '../judgment-invoke.ts'
import type { AuditDraft } from '../../audit.ts'
import type { EndpointRow } from '../../endpoint-table.ts'
import type { RoundRouter } from '../route.ts'
import type { EffRequest, Json } from '../../../kernel/index.ts'

const EFF: EffRequest = { id: 'e'.repeat(64), port: 'self', method: 'm', args: null, caps: {} }

/** 路由到一个调用即抛 `err` 的端点行：模拟判定内效果的传输层失败。 */
function throwingRouter(err: unknown): RoundRouter {
  const row = {
    impl: 'judge',
    gen: 'g'.repeat(64),
    cap: 'self',
    method: 'm',
    transport: 'stdio',
    pid: 1,
    link: {
      call: async () => {
        throw err
      },
    },
  } as unknown as EndpointRow
  return { resolve: () => ({ ok: true, row }) }
}

async function outcomeFor(err: unknown, aborted: boolean): Promise<Json> {
  const drafts: AuditDraft[] = []
  const invoke = createJudgmentInvoke({
    getRouter: () => throwingRouter(err),
    now: () => 1,
    onAudit: (draft) => drafts.push(draft),
  })
  const controller = new AbortController()
  if (aborted) controller.abort()
  await invoke(EMPTY_WORLD, 'judge', EFF, controller.signal)
  expect(drafts).toHaveLength(1)
  return (drafts[0]!.body as { [k: string]: Json })['outcome'] as Json
}

describe('判定内效果取消口径', () => {
  it('真取消：已中止 + cancelled 通道错误 → outcome cancelled', async () => {
    expect(await outcomeFor(new ServiceChannelError('cancelled'), true)).toBe('cancelled')
  })

  it('已中止 + timeout 通道错误 → 不误记为取消（transport_failed）', async () => {
    expect(await outcomeFor(new ServiceChannelError('timeout'), true)).toBe('transport_failed')
  })

  it('已中止 + 非通道错误 → transport_failed，不误记为取消', async () => {
    expect(await outcomeFor(new Error('boom'), true)).toBe('transport_failed')
  })

  it('未中止 + cancelled 通道错误 → 不记取消（口径要求 signal 已中止）', async () => {
    expect(await outcomeFor(new ServiceChannelError('cancelled'), false)).toBe('transport_failed')
  })
})
