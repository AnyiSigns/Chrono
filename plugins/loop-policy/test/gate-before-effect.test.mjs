// 门禁前置于效果（写死条）：gate 判 escalate 时，工具的实际效果必须尚未发出——
// 同 run 内不得出现 `tools.dispatch` 派发（也就不会产生该调用的 EffectAudit）。
// 真 guard 判定接入，覆盖「工具声明 net 越当前档 → gate 应 escalate」的端到端链路。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, directivesOf } from './driver.mjs'
import { judge } from '../../guard/execute/judge.ts'

const TOOLS = [
  {
    name: 'webfetch',
    provider: 'tool-http',
    kind: 'invoke',
    method: null,
    read: null,
    description: 'fetch a url',
    argsSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    caps: { fs: { read: 'none', write: 'none' }, net: 'all' },
    idempotent: true,
  },
]

function summaryOf(value) {
  for (const directive of directivesOf(value)) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function portSequence(service) {
  return service.portCalls.map((call) => `${call.port}.${call.method}`)
}

/** 模型先调 webfetch，工具结果回灌后收尾。 */
function modelProviders(guardProvider, dispatchProbe) {
  return {
    'tools.list': () => ({ tools: TOOLS, rejected: [] }),
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: {} }
      return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'webfetch', args: { url: 'https://example.com' } }], usage: {} }
    },
    'guard.judge': guardProvider,
    'tools.dispatch': (args) => {
      if (dispatchProbe !== undefined) dispatchProbe.count += 1
      return { results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { fetched: true } })) }
    },
  }
}

test('gate escalate（severe 下 webfetch net=all 越档）⇒ 审批入队、同 run 不派发工具', async () => {
  const probe = { count: 0 }
  const service = startService({ providers: modelProviders((args) => judge(args), probe) })
  try {
    const result = await service.interpret({
      tier: 'severe',
      sandbox_tiers: { tiers: { severe: { net: 'limited' } } },
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(service)
    assert.ok(seq.includes('guard.judge'), `gate 应先判：${seq.join(',')}`)
    assert.ok(seq.includes('approval.enqueue'), `escalate 应入队审批：${seq.join(',')}`)
    // 机械证据：gate 判 escalate 且审批未决时，同 run 不得派发该调用（无 EffectAudit 可产）。
    assert.equal(seq.includes('tools.dispatch'), false, `闸门未生效，工具已被派发：${seq.join(',')}`)
    assert.equal(probe.count, 0, '工具提供者不得被触达（效果未发出）')
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'pending')
    assert.equal(summary.pending, 'approval')
  } finally {
    service.close()
  }
})

test('gate allow（auto 档 net=all）⇒ 正常派发（正控）', async () => {
  const probe = { count: 0 }
  const service = startService({ providers: modelProviders((args) => judge(args), probe) })
  try {
    await service.interpret({ tier: 'auto' })
    const seq = portSequence(service)
    assert.ok(seq.includes('guard.judge'))
    assert.ok(seq.includes('tools.dispatch'), `allow 应派发：${seq.join(',')}`)
    assert.equal(probe.count, 1)
  } finally {
    service.close()
  }
})

test('gate escalate 判定的输入面：guard.judge 收到工具声明 net 与档位 net 范围', async () => {
  let seen = null
  const providers = modelProviders((args) => { seen = args; return judge(args) }, undefined)
  const service = startService({ providers })
  try {
    await service.interpret({ tier: 'severe', sandbox_tiers: { tiers: { severe: { net: 'limited' } } } })
    assert.equal(seen.calls[0].net, 'all')
    assert.equal(seen.tier_net, 'limited')
  } finally {
    service.close()
  }
})

test('审批批准续跑：同调用带一次性 grant 后派发（放行面未被误伤）', async () => {
  const probe = { count: 0 }
  const providers = modelProviders((args) => judge(args), probe)
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({ tier: 'severe', sandbox_tiers: { tiers: { severe: { net: 'limited' } } } })
    cursor = first.portCalls.find((call) => call.method === 'enqueue').args.cursor
    assert.equal(cursor.kind, 'approval')
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    const result = await second.interpret({
      tier: 'severe',
      sandbox_tiers: { tiers: { severe: { net: 'limited' } } },
      resume: { cursor, thread: 't1', payload: { verdict: 'approved' } },
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(second)
    assert.ok(seq.includes('tools.dispatch'), `批准后应派发：${seq.join(',')}`)
    assert.equal(probe.count, 1)
    const dispatchCall = second.portCalls.find((call) => call.port === 'tools' && call.method === 'dispatch')
    assert.equal(dispatchCall.args.verdicts, 'approved')
    assert.equal(dispatchCall.args.grant?.net, 'all', '批准签发一次性 net 放宽')
  } finally {
    second.close()
  }
})
