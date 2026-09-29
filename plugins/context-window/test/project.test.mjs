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
