// 上下文投影单元测试：`project.ts` 直接读会话回合步日志（模型形状）→ 中性模型记录。
// 覆盖：用户 / 派发批次（assistant tool_calls + tool 结果）/ 最终正文 / 检查点边界 / verify / 子代理，
// 以及「不读 refs 与展示 parts」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureNative } from './driver.mjs'

process.env.CHRONO_PLUGIN_STATE = ''
ensureNative()

const { projectContext } = await import('../execute/project.ts')
const { turnMetadata } = await import('../execute/views.ts')

function session(turns) {
  return { head: 'ignored-head', refs: { ignored: { id: 'ignored', role: 'user', content: 'REF-ONLY' } }, turns }
}

function texts(record) {
  return record.parts.map((part) => part.text)
}

test('projectContext：用户 → assistant(tool_calls) → tool(结果) → 最终正文，顺序确定', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'step.intent', turn_id: 't1', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
        { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: '先读', parts: [{ type: 'text', text: '先读' }, { type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'a' }, result: { text: 'X' }, status: 'ok' }] }, tool_results: [{ call_id: 'c1', ok: true, result: { text: 'X' } }] },
        { type: 'step.result', turn_id: 't1', seq: 2, assistant: { content: '完成' }, tool_results: [] },
      ],
    },
  ]
  const { records } = projectContext(session(turns), turnMetadata(session(turns)))
  assert.deepEqual(records.map((record) => record.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.deepEqual(texts(records[0]), ['U1'])
  assert.deepEqual(records[1].toolCalls, [{ id: 'c1', name: 'read', arguments: { path: 'a' } }])
  assert.deepEqual(texts(records[1]), ['先读'])
  assert.equal(records[2].toolCallId, 'c1')
  assert.deepEqual(JSON.parse(texts(records[2])[0]), { call_id: 'c1', ok: true, result: { text: 'X' } })
  assert.deepEqual(records[2].toolResult, { tool: 'read', args: { path: 'a' }, verbatim: texts(records[2])[0] })
  assert.deepEqual(texts(records[3]), ['完成'])
  // assistant + 其工具结果同一 atomic 组（同进同出）。
  assert.equal(records[1].group, records[2].group)
  assert.equal(records[1].group !== null, true)
  // refs 被完全忽略。
  assert.ok(!JSON.stringify(records).includes('REF-ONLY'))
})

test('projectContext：失败结果回灌 {call_id, ok:false, error, result}（带 result 时）', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'step.intent', turn_id: 't1', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'shell', arguments: { input: 'node verify.mjs' } }] },
        {
          type: 'step.result',
          turn_id: 't1',
          seq: 1,
          assistant: { content: '' },
          tool_results: [
            { call_id: 'c1', ok: false, error: { code: 'nonzero_exit', message: 'command exited with code 1' }, result: { exit_code: 1, stdout: 'boom', stderr: '' } },
          ],
        },
      ],
    },
  ]
  const { records } = projectContext(session(turns), turnMetadata(session(turns)))
  const tool = records.find((record) => record.role === 'tool')
  assert.ok(tool, '必须有 tool 记录')
  assert.deepEqual(JSON.parse(texts(tool)[0]), {
    call_id: 'c1',
    ok: false,
    error: { code: 'nonzero_exit', message: 'command exited with code 1' },
    result: { exit_code: 1, stdout: 'boom', stderr: '' },
  })
})

test('projectContext：失败无 result 时不合成空 result（保持 {call_id, ok:false, error}）', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'step.intent', turn_id: 't1', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
        {
          type: 'step.result',
          turn_id: 't1',
          seq: 1,
          assistant: { content: '' },
          tool_results: [{ call_id: 'c1', ok: false, error: 'CERR 首行\nCERR 次行' }],
        },
      ],
    },
  ]
  const { records } = projectContext(session(turns), turnMetadata(session(turns)))
  const tool = records.find((record) => record.role === 'tool')
  assert.ok(tool, '必须有 tool 记录')
  assert.deepEqual(JSON.parse(texts(tool)[0]), { call_id: 'c1', ok: false, error: 'CERR 首行\nCERR 次行' })
})

test('projectContext：缺失结果不合成（交由配对修复）；展示 parts 不被读取', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'step.intent', turn_id: 't1', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
        // step.result 的展示 parts 只含工具卡，但无 tool_results → 不产 tool 记录。
        { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: '', parts: [{ type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'a' }, result: { text: 'X' }, status: 'ok' }] }, tool_results: [] },
      ],
    },
  ]
  const { records } = projectContext(session(turns), turnMetadata(session(turns)))
  assert.deepEqual(records.map((record) => record.role), ['user', 'assistant'])
  assert.deepEqual(records[1].toolCalls, [{ id: 'c1', name: 'read', arguments: { path: 'a' } }])
  assert.equal(records.some((record) => record.role === 'tool'), false, '展示工具卡不得伪造 tool 结果')
})

test('projectContext：question 作答步的结果贴在工具调用帧之后，不插空 assistant（续跑模型须见答案且配对合法）', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'step.intent', turn_id: 't1', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'q1', name: 'question', arguments: { questions: [{ id: 'x', question: '过没过？' }] } }] },
        // 挂起收口步：展示 parts 含 question 卡，工具结果为 pending（挂起未决）。
        { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: '先确认一下', parts: [{ type: 'text', text: '先确认一下' }, { type: 'tool', call_id: 'q1', tool: 'question', args: { questions: [] }, result: { status: 'pending' }, status: 'ok' }] }, tool_results: [{ call_id: 'q1', ok: true, result: { status: 'pending' } }] },
        // 作答步：无正文，只带 question 工具结果（answers）——须原位覆盖 pending，不追加第二条。
        { type: 'step.result', turn_id: 't1', seq: 2, assistant: { content: '', parts: [{ type: 'tool', call_id: 'q1', tool: 'question', args: { questions: [] }, result: null, status: 'ok' }] }, tool_results: [{ call_id: 'q1', ok: true, result: { answers: [{ question_id: 'x', selected: ['过'] }] } }] },
      ],
    },
  ]
  const { records } = projectContext(session(turns), turnMetadata(session(turns)))
  assert.deepEqual(records.map((record) => record.role), ['user', 'assistant', 'tool'], '作答步不得再插一条空 assistant / 第二条 tool')
  const assistant = records[1]
  const tool = records[2]
  assert.deepEqual(assistant.toolCalls, [{ id: 'q1', name: 'question', arguments: { questions: [{ id: 'x', question: '过没过？' }] } }])
  assert.equal(tool.toolCallId, 'q1')
  assert.deepEqual(JSON.parse(texts(tool)[0]), { call_id: 'q1', ok: true, result: { answers: [{ question_id: 'x', selected: ['过'] }] } })
  assert.equal(tool.group, assistant.group, '工具结果与调用帧同组（原子保留）')
  assert.equal(tool.toolResult.tool, 'question', '覆盖后保留工具名 / 参数')
})

test('projectContext：跨回合同名 call_id 不互相覆盖（覆盖只在同回合内）', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'step.intent', turn_id: 't1', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
        { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: '' }, tool_results: [{ call_id: 'c1', ok: true, result: { text: 'A' } }] },
      ],
    },
    {
      turn_id: 't2',
      at: '2026-01-01T00:01:00.000Z',
      user_message: { content: 'U2' },
      steps: [
        { type: 'step.intent', turn_id: 't2', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'b' } }] },
        { type: 'step.result', turn_id: 't2', seq: 1, assistant: { content: '' }, tool_results: [{ call_id: 'c1', ok: true, result: { text: 'B' } }] },
      ],
    },
  ]
  const { records } = projectContext(session(turns), turnMetadata(session(turns)))
  const tools = records.filter((record) => record.role === 'tool')
  assert.equal(tools.length, 2, '两回合各保留一条工具结果')
  assert.deepEqual(tools.map((record) => JSON.parse(texts(record)[0]).result.text), ['A', 'B'])
})

test('projectContext：检查点边界 {turn_id, seq} 覆盖其之前的记录，检查点注入一次', () => {
  const turns = [
    { turn_id: 't1', at: '2026-01-01T00:00:00.000Z', user_message: { content: 'U1' }, steps: [{ type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: 'A1' }, tool_results: [] }] },
    {
      turn_id: 't2',
      at: '2026-01-02T00:00:00.000Z',
      user_message: { content: 'U2' },
      steps: [
        { type: 'step.result', turn_id: 't2', seq: 1, assistant: { content: 'A2' }, tool_results: [] },
        { type: 'checkpoint', turn_id: 't2', seq: 2, summary: { goal: '阶段一', findings: [{ claim: 'F' }] }, covered_upto: { turn_id: 't2', seq: 2 } },
        { type: 'step.result', turn_id: 't2', seq: 3, assistant: { content: 'A2b' }, tool_results: [] },
      ],
    },
    { turn_id: 't3', at: '2026-01-03T00:00:00.000Z', user_message: { content: 'U3' }, steps: [] },
  ]
  const meta = turnMetadata(session(turns))
  const { records, checkpoint } = projectContext(session(turns), meta)
  assert.ok(checkpoint !== null && checkpoint.checkpoint === true)
  const covered = records.filter((record) => record.covered).map((record) => texts(record).join(''))
  assert.deepEqual(covered, ['U1', 'A1', 'U2', 'A2'], '边界之前的记录打 covered 标记')
  const kept = records.filter((record) => !record.covered).map((record) => texts(record).join(''))
  assert.deepEqual(kept, ['[检查点]\n目标：阶段一\n发现：\n- F', 'A2b', 'U3'])
  assert.equal(records.filter((record) => record.checkpoint).length, 1, '检查点只注入一次')
})

test('projectContext：verify / 子代理结果作为 system 记录，不产生无 id 的 tool 消息且不算边界', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'checkpoint', turn_id: 't1', seq: 1, summary: { kind: 'verify', text: 'verify: {"passed":true}' }, covered_upto: 1 },
        { type: 'checkpoint', turn_id: 't1', seq: 2, summary: { kind: 'subagent', goal: '子任务' }, covered_upto: 2 },
      ],
    },
  ]
  const { records, checkpoint } = projectContext(session(turns), turnMetadata(session(turns)))
  assert.equal(checkpoint, null, '子代理结果不构成会话检查点')
  assert.deepEqual(records.map((record) => record.role), ['user', 'system', 'system'])
  assert.deepEqual(texts(records[1]), ['verify: {"passed":true}'])
  assert.ok(texts(records[2])[0].startsWith('[子代理]'))
  assert.equal(records.every((record) => record.toolCallId === null), true, 'verify / 子代理不得产 tool_call_id')
  assert.equal(records.every((record) => record.covered === false), true, '无会话边界 → 不覆盖')
})

test('projectContext：step.user 依步号原位落一条用户记录（进下一轮模型上下文）', () => {
  const turns = [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      user_message: { content: 'U1' },
      steps: [
        { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: 'A1' }, tool_results: [] },
        { type: 'step.user', turn_id: 't1', seq: 2, insert_id: 'i1', user_message: { content: 'INSERT' } },
        { type: 'step.result', turn_id: 't1', seq: 3, assistant: { content: 'A2' }, tool_results: [] },
      ],
    },
  ]
  const { records } = projectContext(session(turns), turnMetadata(session(turns)), 't1')
  assert.deepEqual(records.map((record) => record.role), ['assistant', 'user', 'assistant'])
  assert.deepEqual(texts(records[1]), ['INSERT'])
  assert.equal(records[1].step, 2)
  // 本轮用户消息不投影（bag.input 权威）。
  assert.ok(!JSON.stringify(records).includes('U1'))
})
