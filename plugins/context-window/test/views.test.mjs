// 投影单元测试：`view.display`（UI 完整时间线）与回合日志元数据（`turnMetadata`，供 view.context 分层）。
// 直接 import execute 源码。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureNative } from './driver.mjs'

process.env.CHRONO_PLUGIN_STATE = ''
ensureNative()

const { displayView, turnMetadata, renderCheckpoint, isStructuredCheckpoint } = await import('../execute/views.ts')

function session(turns, refs = {}) {
  return { head: null, refs, turns }
}

test('turnMetadata：距离、工具调用步号、结构化检查点与覆盖边界', () => {
  const meta = turnMetadata(
    session([
      { turn_id: 't1', steps: [] },
      {
        turn_id: 't2',
        steps: [
          { type: 'step.intent', turn_id: 't2', seq: 4, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
          { type: 'checkpoint', turn_id: 't2', seq: 5, summary: { goal: 'g', covered_upto: 5 }, covered_upto: 5 },
        ],
      },
      {
        turn_id: 't3',
        steps: [{ type: 'checkpoint', turn_id: 't3', seq: 8, summary: { kind: 'segment', iter: 2 }, covered_upto: 8 }],
      },
    ]),
  )
  assert.deepEqual(meta.order, ['t1', 't2', 't3'])
  assert.equal(meta.distances.get('t1'), 2)
  assert.equal(meta.distances.get('t3'), 0)
  assert.equal(meta.callStep.get('c1'), 4)
  assert.equal(meta.checkpoint.turn_id, 't2')
  assert.equal(meta.checkpoint.summary.goal, 'g')
  assert.deepEqual([...meta.coveredTurnIds].sort(), ['t1', 't2'], '段标记（kind:segment）不是结构化检查点')
})

test('turnMetadata：同回合在 covered_upto 之后仍有步 → 该回合不被覆盖', () => {
  const meta = turnMetadata(
    session([
      { turn_id: 't1', steps: [] },
      {
        turn_id: 't2',
        steps: [
          { type: 'checkpoint', turn_id: 't2', seq: 4, summary: { goal: 'g' }, covered_upto: 4 },
          { type: 'step.result', turn_id: 't2', seq: 9, assistant: { content: 'x' } },
        ],
      },
    ]),
  )
  assert.deepEqual([...meta.coveredTurnIds], ['t1'])
})

test('isStructuredCheckpoint / renderCheckpoint：结构化字段渲染成确定文本', () => {
  assert.equal(isStructuredCheckpoint({ goal: 'g' }), true)
  assert.equal(isStructuredCheckpoint({ kind: 'segment', iter: 1 }), false)
  assert.equal(isStructuredCheckpoint({ kind: 'verify', text: 't' }), false)
  assert.equal(isStructuredCheckpoint({ note: 'x' }), false)
  const text = renderCheckpoint({
    goal: '目标 A',
    constraints: ['不写世界'],
    decisions: [{ what: '换只读投影', why: '安全', at_step: 3 }],
    findings: [{ claim: '缺陷在 foo.ts', evidence: { handle: 'h-1' } }],
    files: [{ path: 'src/foo.ts', state: 'read', summary: '入口' }],
    open_questions: ['是否要迁移'],
    next_steps: ['写测试'],
    errors_to_avoid: [{ what: '直接改 packages', why: '已冻结' }],
    user_preferences: ['中文注释'],
  })
  assert.ok(text.includes('目标：目标 A'))
  assert.ok(text.includes('约束：\n- 不写世界'))
  assert.ok(text.includes('换只读投影（安全）'))
  assert.ok(text.includes('缺陷在 foo.ts'))
  assert.ok(text.includes('src/foo.ts（read · 入口）'))
  assert.ok(text.includes('应避免的错误'))
  assert.ok(text.includes('用户偏好'))
})

test('view.display：逐回合完整时间线（用户消息 / 推理 / 正文 / 工具卡与结果）', () => {
  const view = displayView(
    session(
      [
        {
          turn_id: 't1',
          at: '2026-01-01T00:00:00.000Z',
          state: 'settled',
          outcome: { kind: 'committed', retryable: false },
          steps: [
            { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: '回复' } },
            {
              type: 'step.result',
              turn_id: 't1',
              seq: 3,
              assistant: {
                content: '回复',
                parts: [
                  { type: 'reasoning', text: '思考' },
                  { type: 'text', text: '回复' },
                  { type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'a' }, result: { text: 'X' }, status: 'ok' },
                ],
              },
            },
          ],
        },
      ],
      { 'msg-c1-t1-user': { id: 'msg-c1-t1-user', role: 'user', content: '问题' } },
    ),
  )
  assert.equal(view.length, 1)
  assert.equal(view[0].turn_id, 't1')
  assert.equal(view[0].state, 'settled')
  assert.deepEqual(view[0].outcome, { kind: 'committed', retryable: false })
  assert.deepEqual(
    view[0].items.map((item) => item.kind),
    ['user', 'reasoning', 'text', 'tool'],
  )
  const tool = view[0].items[3]
  assert.equal(tool.call_id, 'c1')
  assert.equal(tool.tool, 'read')
  assert.deepEqual(tool.result, { text: 'X' })
  assert.equal(tool.status, 'ok')
})
