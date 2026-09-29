// 展示投影单元测试：`session/execute/project.ts` 直接读回合步日志（展示形状）→ 展示消息链 / 时间线。
// 覆盖：用户正文与附件、助手展示 parts（reasoning / text / 工具卡）、检查点与 verify 标记，
// 以及「不读 refs」。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { displayMessagesByTurn, displayTimeline } = await import('../execute/project.ts')

function turns() {
  return [
    {
      turn_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
      state: 'settled',
      outcome: { kind: 'committed', retryable: false },
      user_message: { content: 'U1', attachments: [{ kind: 'file', name: 'a.txt' }] },
      steps: [
        {
          type: 'step.result',
          turn_id: 't1',
          seq: 1,
          assistant: {
            content: '正文',
            parts: [
              { type: 'reasoning', text: '思考' },
              { type: 'text', text: '正文' },
              { type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'a' }, render: { form: 'line' }, result: { text: 'X' }, status: 'ok' },
            ],
          },
        },
        { type: 'checkpoint', turn_id: 't1', seq: 2, summary: { kind: 'verify', text: 'verify: {"passed":true}' }, covered_upto: 2 },
        { type: 'checkpoint', turn_id: 't1', seq: 3, summary: { goal: '阶段一' }, covered_upto: 3 },
      ],
    },
    {
      turn_id: 't2',
      at: '2026-01-02T00:00:00.000Z',
      state: 'open',
      outcome: null,
      user_message: { content: 'U2' },
      steps: [{ type: 'step.result', turn_id: 't2', seq: 1, assistant: { content: 'A2' } }],
    },
  ]
}

test('displayMessagesByTurn：回合日志 → 展示消息链（旧→新，prev 串联，id 稳定）', () => {
  const groups = displayMessagesByTurn('c1', turns())
  assert.deepEqual(groups.map((group) => group.turnId), ['t1', 't2'])
  const flat = groups.flatMap((group) => group.messages)
  assert.deepEqual(flat.map((entry) => entry.hash), [
    'msg-c1-t1-user',
    'msg-c1-t1-assistant',
    'msg-c1-t2-user',
    'msg-c1-t2-assistant',
  ])
  assert.deepEqual(flat.map((entry) => entry.def.content), ['U1', '正文', 'U2', 'A2'])
  assert.equal(flat[0].def.attachments[0].name, 'a.txt')
  assert.equal(flat[0].def.prev, null)
  assert.deepEqual(flat[1].def.prev, { def: 'msg-c1-t1-user' })
  assert.deepEqual(flat[3].def.prev, { def: 'msg-c1-t2-user' })
})

test('displayTimeline：用户 / 推理 / 正文 / 工具卡 / verify / 检查点标记', () => {
  const timeline = displayTimeline(turns())
  assert.deepEqual(timeline.map((turn) => turn.turn_id), ['t1', 't2'])
  assert.deepEqual(timeline[0].items.map((item) => item.kind), ['user', 'reasoning', 'text', 'tool', 'verify', 'checkpoint'])
  const tool = timeline[0].items[3]
  assert.equal(tool.call_id, 'c1')
  assert.equal(tool.tool, 'read')
  assert.deepEqual(tool.args, { path: 'a' })
  assert.equal(tool.status, 'ok')
  assert.deepEqual(tool.result, { text: 'X' })
  assert.equal(timeline[0].items[4].text, 'verify: {"passed":true}')
  assert.ok(String(timeline[0].items[5].text).includes('目标：阶段一'))
  // 无 parts 时回落 content。
  assert.deepEqual(timeline[1].items.map((item) => item.kind), ['user', 'text'])
})

test('displayTimeline：不读 refs（refs 全量不进入展示投影）', () => {
  const noTurns = { head: 'h', refs: { h: { id: 'h', role: 'user', content: 'REF-ONLY' } }, turns: [] }
  assert.deepEqual(displayMessagesByTurn('c1', noTurns.turns), [])
  assert.deepEqual(displayTimeline(noTurns.turns), [])
})

test('step.user：回合运行中插入的用户消息进展示链与时间线（原位、幂等 id）', () => {
  const withInsert = [
    {
      turn_id: 't3',
      at: '2026-01-03T00:00:00.000Z',
      state: 'open',
      outcome: null,
      user_message: { content: 'U3' },
      steps: [
        { type: 'step.result', turn_id: 't3', seq: 3, assistant: { content: 'A3' } },
        {
          type: 'step.user',
          turn_id: 't3',
          seq: 4,
          insert_id: 'i1',
          user_message: { content: 'INSERT', at: '2026-01-03T00:00:01.000Z' },
        },
      ],
    },
  ]
  const groups = displayMessagesByTurn('c1', withInsert)
  assert.deepEqual(groups[0].messages.map((entry) => entry.hash), [
    'msg-c1-t3-user',
    'msg-c1-t3-user-i1',
    'msg-c1-t3-assistant',
  ])
  assert.deepEqual(groups[0].messages.map((entry) => entry.def.content), ['U3', 'INSERT', 'A3'])
  assert.equal(groups[0].messages[1].def.role, 'user')
  const timeline = displayTimeline(withInsert)
  assert.deepEqual(timeline[0].items.map((item) => item.kind), ['user', 'user', 'text'])
  assert.equal(timeline[0].items[1].text, 'INSERT')
})
