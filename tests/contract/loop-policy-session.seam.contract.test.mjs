// 接缝契约 3：loop-policy ↔ session。
// 共享真源：chain-contract/fixtures/step-records.json。
// 消费方向：真实 session 服务消费真实 loop-policy 解释器发出的 step_append（intent / result / checkpoint）。
// 供给方向：真实 loop-policy 的步记录重建函数把 session 步记录重组回 view.context 与 view.display。
// 至少一侧为真实服务：两个方向都起真实 loop-policy 与真实 session 服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stepRecords } from '../../chain-contract/fixtures/index.ts'
import { restoreFromSteps } from '../../plugins/loop-policy/execute/reconstruct.ts'
import { displayParts } from '../../plugins/loop-policy/execute/commit-parts.ts'
import { startService as startLoop, defaultProviders } from '../../plugins/loop-policy/test/driver.mjs'
import { startRealService, makeRouter, FIXED_ENV } from './_bridge.mjs'

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
    render: { kind: 'fetch' },
  },
]

let dirSeq = 0
function tempDataDir() {
  dirSeq += 1
  return mkdtempSync(join(tmpdir(), `seam-session3-${process.pid}-${dirSeq}-`))
}

async function value(service, port, method, args, env = FIXED_ENV) {
  const frame = await service.call(port, method, args, env)
  assert.equal(frame.kind, 'result', JSON.stringify(frame))
  return frame.value
}

/** 真实 session 服务的路由应答（把回帧转成 provider 回值；错误抛出）。 */
function forwardValue(session) {
  return (args, message) =>
    session.call(message.port, message.method, args, message.env).then((frame) => {
      if (frame.kind === 'error') throw new Error(`${frame.error}: ${frame.message}`)
      return frame.value
    })
}

/** 模型先调 webfetch，工具结果回灌后收尾。 */
function modelProviders() {
  return defaultProviders({
    'tools.list': () => ({ tools: TOOLS, rejected: [] }),
    'model.chat': (args) => {
      const last = Array.isArray(args.messages) ? args.messages[args.messages.length - 1] : null
      if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'webfetch', args: { url: 'https://example.com' } }],
        usage: {},
      }
    },
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { fetched: true } })),
    }),
  })
}

test('消费向：真实 session 消费真实 loop-policy 发出的 step_append', async () => {
  const dir = tempDataDir()
  const session = startRealService({
    name: 'session',
    env: { CHRONO_PLUGIN_DATA: dir, CHRONO_PLUGIN_STATE: dir },
    onPortCall: makeRouter({ 'input.clear': () => ({ ok: true }) }),
  })
  const loop = startLoop({
    providers: {
      ...modelProviders(),
      'session.step_append': forwardValue(session),
      'session.turn_settle': forwardValue(session),
    },
  })
  try {
    await session.hello()
    const turnId = 't-seam-3'
    const opened = await value(session, 'session', 'turn_open', {
      turn_id: turnId,
      user_message: { role: 'user', content: 'fetch example' },
      slot_ref: 'run-seam-3',
      thread_id: 't1',
      new_conversation: { id: 'c-seam-3', workspace_id: 'w-1', title: 'seam3' },
    })
    assert.equal(opened.status, 'created')

    const result = await loop.interpret({ tier: 'auto', turn_id: turnId, thread: 't1' })
    assert.equal(result.kind, 'result', JSON.stringify(result))

    const read = await value(session, 'session', 'read', { conversation: 'c-seam-3' })
    const turn = read.turns.find((item) => item.turn_id === turnId)
    assert.ok(turn !== undefined, 'session 须存有该回合')
    const types = turn.steps.map((step) => step.type)
    assert.ok(types.includes('step.intent'), `须先写意图：${types.join(',')}`)
    assert.ok(types.includes('step.result'), `须写工具结果：${types.join(',')}`)
    // 真实 loop-policy 确实发过 append（驱动桥记录）。
    assert.ok(loop.portCalls.some((call) => call.port === 'session' && call.method === 'step_append'))
  } finally {
    loop.close()
    session.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('供给向：步记录经真实重建函数回到 view.context 与 view.display', () => {
  const INTENT = stepRecords.find((record) => record.type === 'step.intent')
  const RESULT = stepRecords.find((record) => record.type === 'step.result')
  const CHECKPOINT = stepRecords.find((record) => record.type === 'checkpoint')

  const { rs } = restoreFromSteps([INTENT, RESULT, CHECKPOINT])
  // view.context：重建出的 extra_messages 须含 assistant(tool_calls) → tool(结果) 的规范配对。
  const assistant = rs.extraMessages.find((message) => message.role === 'assistant')
  assert.ok(assistant !== undefined, '须重建 assistant 承接帧')
  assert.equal(assistant.tool_calls[0].id, 'call-0')
  assert.equal(assistant.tool_calls[0].name, 'fs.read')
  const tool = rs.extraMessages.find((message) => message.role === 'tool')
  assert.ok(tool !== undefined, '须重建工具结果消息')
  assert.equal(tool.tool_call_id, 'call-0')

  // view.display：同一时间线折叠成工具卡展示段，结果回填状态。
  const parts = displayParts(rs.extraMessages, null, [])
  const card = parts.find((part) => part.type === 'tool' && part.call_id === 'call-0')
  assert.ok(card !== undefined, '折叠出工具卡')
  assert.equal(card.tool, 'fs.read')
  assert.equal(card.status, 'ok')
  assert.equal(card.result.path, 'foo.ts')
})

test('供给向：空步记录重建为空上下文（不猜测）', () => {
  const { rs } = restoreFromSteps([])
  assert.deepEqual(rs.extraMessages, [])
  assert.equal(displayParts([], null, []).length, 0)
})
