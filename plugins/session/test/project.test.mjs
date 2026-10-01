// 展示投影单元测试：`session/execute/project.ts` 把回合步日志摊平成单一有序事件流（展示形状）。
// 覆盖：用户正文与附件、助手**塌成一条**（每回合一个助手段，不每轮分层）、工具结果回填不新建消息、
// 运行中插入的 user 依追加序切断助手段（插入前 / 插入后两段）、verify 标记，以及「不读 refs」。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { displayMessagesByTurn, displayTimeline, flattenTurnEvents } = await import('../execute/project.ts')

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

test('displayMessagesByTurn：扁平事件流 → 展示消息链（旧→新，prev 串联，id 稳定）', () => {
  const groups = displayMessagesByTurn('c1', turns())
  assert.deepEqual(groups.map((group) => group.turnId), ['t1', 't2'])
  const flat = groups.flatMap((group) => group.messages)
  assert.deepEqual(flat.map((entry) => entry.hash), [
    'msg-c1-t1-user',
    'msg-c1-t1-assistant-1',
    'msg-c1-t2-user',
    'msg-c1-t2-assistant-1',
  ])
  assert.deepEqual(flat.map((entry) => entry.def.content), ['U1', '正文', 'U2', 'A2'])
  assert.equal(flat[0].def.attachments[0].name, 'a.txt')
  assert.equal(flat[0].def.prev, null)
  assert.deepEqual(flat[1].def.prev, { def: 'msg-c1-t1-user' })
  assert.deepEqual(flat[3].def.prev, { def: 'msg-c1-t2-user' })
})

test('displayTimeline：用户 / 推理 / 正文 / 工具卡 / verify 标记', () => {
  const timeline = displayTimeline(turns())
  assert.deepEqual(timeline.map((turn) => turn.turn_id), ['t1', 't2'])
  assert.deepEqual(timeline[0].items.map((item) => item.kind), ['user', 'reasoning', 'text', 'tool', 'verify'])
  const tool = timeline[0].items[3]
  assert.equal(tool.call_id, 'c1')
  assert.equal(tool.tool, 'read')
  assert.deepEqual(tool.args, { path: 'a' })
  assert.equal(tool.status, 'ok')
  assert.deepEqual(tool.result, { text: 'X' })
  assert.equal(timeline[0].items[4].text, 'verify: {"passed":true}')
  // 无 parts 时回落 content。
  assert.deepEqual(timeline[1].items.map((item) => item.kind), ['user', 'text'])
})

test('displayTimeline：不读 refs（refs 全量不进入展示投影）', () => {
  const noTurns = { head: 'h', refs: { h: { id: 'h', role: 'user', content: 'REF-ONLY' } }, turns: [] }
  assert.deepEqual(displayMessagesByTurn('c1', noTurns.turns), [])
  assert.deepEqual(displayTimeline(noTurns.turns), [])
})

test('助手塌成一条：多次 step.result（内容不同 / 含新块）合并进同一条消息', () => {
  const turn = {
    turn_id: 't',
    at: '2026-01-03T00:00:00.000Z',
    state: 'open',
    outcome: null,
    user_message: { content: 'U' },
    steps: [
      { type: 'step.result', turn_id: 't', seq: 1, assistant: { content: 'A1', parts: [{ type: 'text', text: 'A1' }, { type: 'tool', call_id: 'c1', tool: 'read' }] } },
      // 本步增量只含新正文块（不重复前段 parts）。
      { type: 'step.result', turn_id: 't', seq: 3, assistant: { content: 'A2', parts: [{ type: 'text', text: 'A2' }] } },
    ],
  }
  const messages = displayMessagesByTurn('c', [turn])[0].messages
  assert.deepEqual(messages.map((entry) => entry.hash), ['msg-c-t-user', 'msg-c-t-assistant-1'])
  assert.deepEqual(messages.map((entry) => entry.def.content), ['U', 'A1A2'])
  assert.deepEqual(messages[1].def.parts, [
    { type: 'text', text: 'A1' },
    { type: 'tool', call_id: 'c1', tool: 'read' },
    { type: 'text', text: 'A2' },
  ])
})

test('助手纯文本步：增量全为文本（不落 parts）时补 text part，塌成一条后正文不丢', () => {
  const turn = {
    turn_id: 't',
    at: '2026-01-03T00:00:00.000Z',
    state: 'open',
    outcome: null,
    user_message: { content: 'U' },
    steps: [
      { type: 'step.result', turn_id: 't', seq: 1, assistant: { content: '', parts: [{ type: 'tool', call_id: 'c1', tool: 'read', status: 'ok' }] } },
      { type: 'step.result', turn_id: 't', seq: 2, assistant: { content: 'A2' } },
    ],
  }
  const messages = displayMessagesByTurn('c', [turn])[0].messages
  assert.deepEqual(messages.map((entry) => entry.hash), ['msg-c-t-user', 'msg-c-t-assistant-1'])
  assert.equal(messages[1].def.content, 'A2')
  assert.deepEqual(messages[1].def.parts, [
    { type: 'tool', call_id: 'c1', tool: 'read', status: 'ok' },
    { type: 'text', text: 'A2' },
  ])
})

test('助手工具回填：同段 step.result 不新建消息，结果合入本段工具卡', () => {
  const turn = {
    turn_id: 't',
    at: '2026-01-03T00:00:00.000Z',
    state: 'open',
    outcome: null,
    user_message: { content: 'U' },
    steps: [
      { type: 'step.result', turn_id: 't', seq: 1, assistant: { content: '', parts: [{ type: 'tool', call_id: 'c1', tool: 'read' }] } },
      { type: 'step.result', turn_id: 't', seq: 2, assistant: { content: '', parts: [{ type: 'tool', call_id: 'c1', tool: 'read', status: 'ok', result: { text: 'X' } }] } },
    ],
  }
  const messages = displayMessagesByTurn('c', [turn])[0].messages
  assert.deepEqual(messages.map((entry) => entry.hash), ['msg-c-t-user', 'msg-c-t-assistant-1'])
  assert.equal(messages[1].def.parts[0].status, 'ok')
})

test('step.user：运行中插入的 user 落在其前后助手段之间（回复出现在插入之后）', () => {
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
        { type: 'step.result', turn_id: 't3', seq: 5, assistant: { content: 'REPLY' } },
      ],
    },
  ]
  const groups = displayMessagesByTurn('c1', withInsert)
  assert.deepEqual(groups[0].messages.map((entry) => entry.hash), [
    'msg-c1-t3-user',
    'msg-c1-t3-assistant-1',
    'msg-c1-t3-user-i1',
    'msg-c1-t3-assistant-2',
  ])
  assert.deepEqual(groups[0].messages.map((entry) => entry.def.content), ['U3', 'A3', 'INSERT', 'REPLY'])
  assert.equal(groups[0].messages[2].def.role, 'user')
  const timeline = displayTimeline(withInsert)
  assert.deepEqual(timeline[0].items.map((item) => item.kind), ['user', 'text', 'user', 'text'])
  assert.deepEqual(timeline[0].items.map((item) => item.text), ['U3', 'A3', 'INSERT', 'REPLY'])
})

test('step.user：同一工具卡跨插入段只出现一次（结果 / render 回填到首次出现的段）', () => {
  const turn = {
    turn_id: 't4',
    at: '2026-01-04T00:00:00.000Z',
    state: 'open',
    outcome: null,
    user_message: { content: 'U4' },
    steps: [
      {
        type: 'step.result',
        turn_id: 't4',
        seq: 1,
        assistant: {
          content: '',
          parts: [{ type: 'reasoning', text: 'R' }, { type: 'tool', call_id: 'c1', tool: 'shell', render: null }],
        },
      },
      {
        type: 'step.user',
        turn_id: 't4',
        seq: 2,
        insert_id: 'i1',
        user_message: { content: 'INSERT', at: '2026-01-04T00:00:01.000Z' },
      },
      {
        type: 'step.result',
        turn_id: 't4',
        seq: 3,
        assistant: {
          content: 'DONE',
          parts: [
            {
              type: 'tool',
              call_id: 'c1',
              tool: 'shell',
              status: 'ok',
              render: { form: 'card', label: 'shell', detail: { kind: 'terminal' } },
              result: { combined: [{ stream: 'stdout', text: 'X' }] },
            },
          ],
        },
      },
    ],
  }
  const messages = displayMessagesByTurn('c', [turn])[0].messages
  const toolParts = messages
    .flatMap((entry) => (Array.isArray(entry.def.parts) ? entry.def.parts : []))
    .filter((part) => part.type === 'tool' && part.call_id === 'c1')
  // 同一 call_id 跨插入段只保留首次出现的那张卡，结果 / render 原位回填，不再重复。
  assert.equal(toolParts.length, 1)
  assert.equal(toolParts[0].status, 'ok')
  assert.deepEqual(toolParts[0].result, { combined: [{ stream: 'stdout', text: 'X' }] })
  assert.deepEqual(toolParts[0].render, { form: 'card', label: 'shell', detail: { kind: 'terminal' } })
})

test('兼容旧日志：累积前缀 parts 取增量合并，迁移重放不重复', () => {
  const turn = {
    turn_id: 't',
    at: '2026-01-03T00:00:00.000Z',
    state: 'open',
    outcome: null,
    user_message: { content: 'U' },
    steps: [
      { type: 'step.result', turn_id: 't', seq: 1, assistant: { content: 'A1', parts: [{ type: 'text', text: 'A1' }, { type: 'tool', call_id: 'c1', tool: 'read' }] } },
      { type: 'step.result', turn_id: 't', seq: 2, assistant: { content: 'A1', parts: [{ type: 'text', text: 'A1' }, { type: 'tool', call_id: 'c1', tool: 'read', status: 'ok', result: { text: 'X' } }] } },
      { type: 'step.result', turn_id: 't', seq: 3, assistant: { content: 'A2', parts: [{ type: 'text', text: 'A1' }, { type: 'tool', call_id: 'c1', tool: 'read', status: 'ok', result: { text: 'X' } }, { type: 'text', text: 'A2' }] } },
    ],
  }
  const messages = displayMessagesByTurn('c', [turn])[0].messages
  assert.deepEqual(messages.map((entry) => entry.hash), ['msg-c-t-user', 'msg-c-t-assistant-1'])
  assert.deepEqual(messages.map((entry) => entry.def.content), ['U', 'A1A2'])
  assert.deepEqual(messages[1].def.parts, [
    { type: 'text', text: 'A1' },
    { type: 'tool', call_id: 'c1', tool: 'read', status: 'ok', result: { text: 'X' } },
    { type: 'text', text: 'A2' },
  ])
})

test('flattenTurnEvents：每个同级事件带 turn_id 与 parent（分支 / 多 agent 元数据可表达）', () => {
  const events = flattenTurnEvents('c1', turns()[0])
  assert.deepEqual(events.map((event) => event.kind), ['user', 'assistant', 'verify'])
  assert.equal(events[0].parent, null)
  assert.equal(events[1].parent, 'msg-c1-t1-user')
  assert.equal(events[2].parent, 'msg-c1-t1-assistant-1')
  assert.ok(events.every((event) => event.turn_id === 't1'))
})
