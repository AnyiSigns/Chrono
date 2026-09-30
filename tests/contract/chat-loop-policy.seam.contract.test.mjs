// 接缝契约 1：chat ↔ loop-policy。
// 共享真源：chain-contract/fixtures/interpret-bag.json（chat 生产、loop-policy 消费的唯一形状）。
// 供给方向：真实 loop-policy 服务消费 chat 的真实装配产物（夹具与 buildInterpretBag 双份输入）。
// 消费方向：真实 chat 服务消费真实 loop-policy 服务返回的 `$directives` 与结局摘要。
// 至少一侧为真实服务：两个方向都起真实服务（loop-policy 经插件驱动，chat 经 seambridge）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { interpretBag } from '../../chain-contract/fixtures/index.ts'
import { validateBag } from '../../chain-contract/src/runtime.ts'
import { buildInterpretBag, modelConfigOf } from '../../plugins/chat/execute/assemble.ts'
import { loadWiring } from '../../plugins/chat/execute/wiring.ts'
import { startService as startLoop, defaultProviders } from '../../plugins/loop-policy/test/driver.mjs'
import { startRealService, makeRouter, relayFrame, FIXED_ENV } from './_bridge.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 从夹具值装配 chat 侧 `buildInterpretBag` 的真实入参（投影切片 + 装配参数）。 */
function realBagInputs() {
  const sessionBody = {
    version: 1,
    current: interpretBag.session.current,
    conversations: clone(interpretBag.session.conversations),
  }
  const conversation = sessionBody.conversations[0]
  const ids = {
    input: { body: interpretBag.input_body },
    session: { body: sessionBody, refs: {} },
    config: { body: interpretBag.config },
  }
  const slot = interpretBag.input_body.slots[interpretBag.thread]
  return {
    ids,
    wiring: loadWiring(),
    slot,
    conversation,
    conversationId: conversation.id,
    config: modelConfigOf(ids),
    thread: interpretBag.thread,
  }
}

function externSummaryOf(value) {
  const directives = Array.isArray(value?.$directives) ? value.$directives : []
  for (const directive of directives) {
    if (directive?.kind === 'extern' && directive.payload?.kind === 'interpret') return directive.payload
  }
  return null
}

test('供给向：真实 loop-policy 消费夹具 bag（唯一夹具源）', async () => {
  const service = startLoop({ providers: defaultProviders() })
  try {
    const result = await service.interpret(clone(interpretBag))
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const value = result.value
    assert.ok(Array.isArray(value.$directives), '计划须含 $directives')
    const summary = externSummaryOf(value)
    assert.ok(summary !== null, '计划须含 interpret 结局摘要')
    assert.equal(typeof summary.ended, 'string')
    assert.equal(summary.turn_id, undefined, '无 turn_id 的单测直调不产生回合摘要')
  } finally {
    service.close()
  }
})

test('供给向：真实 loop-policy 消费 buildInterpretBag 的真实产物，且产物过共享 schema', async () => {
  const inputs = realBagInputs()
  const bag = buildInterpretBag(inputs)
  const checked = validateBag(bag)
  assert.equal(checked.ok, true, JSON.stringify(checked.outcome))
  const service = startLoop({ providers: defaultProviders() })
  try {
    const result = await service.interpret(clone(bag))
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.ok(Array.isArray(result.value.$directives))
    assert.ok(externSummaryOf(result.value) !== null)
  } finally {
    service.close()
  }
})

test('消费向：真实 chat 消费真实 loop-policy 的 $directives 与结局摘要', async () => {
  const loop = startLoop({ providers: defaultProviders() })
  const sessionTurnId = 't-run-seam'
  let loopCalled = 0
  const configBody = {
    vendor: 'anthropic',
    model: 'claude-sonnet-4-6',
    base_url: 'http://127.0.0.1:1',
    auth_ref: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
    params: { max_tokens: 256 },
    providers: {
      anthropic: {
        name: 'anthropic',
        protocol: 'anthropic-messages',
        base_url: 'http://127.0.0.1:1',
        models: { 'claude-sonnet-4-6': { name: 'claude-sonnet-4-6', context_window: 200000, max_output: 256 } },
      },
    },
  }
  const slot = { kind: 'chat.message', text: interpretBag.input.content, workspace_id: 'w-1', conversation_id: 'c-1' }
  const routes = {
    'session.read': () => ({ version: 1, current: 'c-1', conversations: [{ id: 'c-1', workspace_id: 'w-1', kind: 'main', title: 't', count: 0, head: null }] }),
    'session.turn_open': () => ({ ok: true, status: 'created', turn_id: sessionTurnId, conversation: 'c-1' }),
    'session.turn_settle': (args) => ({ ok: true, turn_id: args.turn_id, outcome: args.outcome, persisted: true }),
    'input.read': () => ({ slots: { t1: slot }, slot_ref: 'run-seam' }),
    'todo.invoke': () => ({ ok: true, result: { items: [] } }),
    'config.read': () => ({ body: configBody }),
    'mcp.read': () => ({ tools: [] }),
    'workspace.read': () => ({ workspaces: [{ id: 'w-1', path: '/repo' }] }),
    'skill.read': () => ({ skills: [] }),
    'loop-policy.interpret': (args, message) => {
      loopCalled += 1
      return loop.interpret(args, message.env ?? FIXED_ENV).then(relayFrame)
    },
  }
  const chat = startRealService({ name: 'chat', onPortCall: makeRouter(routes) })
  try {
    await chat.hello()
    const response = await chat.call('chat', 'send', { ids: {} }, FIXED_ENV)
    assert.equal(response.kind, 'result', JSON.stringify(response))
    assert.equal(loopCalled, 1, 'chat 须经真实 loop-policy 解释器')
    const plan = response.value
    assert.ok(Array.isArray(plan.$directives), 'chat 回帧须是合并后的 $directives')
    assert.equal(externSummaryOf(plan) !== null, true, 'chat 须上提解释器结局摘要')
    // 真实 loop-policy 服务确被触达（反向帧证据）。
    assert.ok(loop.portCalls.length > 0)
  } finally {
    chat.close()
    loop.close()
  }
})
