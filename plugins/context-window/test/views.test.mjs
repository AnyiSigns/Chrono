// 上下文侧元数据单元测试：`turnMetadata`（距离 / 工具调用步号）、`renderCheckpoint`。
// 展示投影归 session 所有，其测试在 plugins/session/test/project.test.mjs。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureNative } from './driver.mjs'

process.env.CHRONO_PLUGIN_STATE = ''
ensureNative()

const { turnMetadata, renderCheckpoint } = await import('../execute/views.ts')

function session(turns) {
  return { head: null, refs: {}, turns }
}

test('turnMetadata：距离与工具调用步号', () => {
  const meta = turnMetadata(
    session([
      { turn_id: 't1', steps: [] },
      {
        turn_id: 't2',
        steps: [
          { type: 'step.intent', turn_id: 't2', seq: 4, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
          { type: 'checkpoint', turn_id: 't2', seq: 5, summary: { goal: 'g' }, covered_upto: { turn_id: 't2', seq: 5 } },
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
})

test('renderCheckpoint：结构化字段渲染成确定文本', () => {
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
