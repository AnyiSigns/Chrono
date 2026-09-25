// `question` 自有持久存储测试（node --test）：写读往返、边跑边追加、同回合幂等、跨重启重放、中断残留可辨、
// 世界不新增世代（存储层不产 directive）。直接驱动 store（不经协议），验证 ④ 引擎性质。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QuestionStore, questionId } from '../execute/store.ts'

function tempRoot(label) {
  return mkdtempSync(join(tmpdir(), `question-store-${label}-`))
}

function envFor(root) {
  return { CHRONO_PLUGIN_DATA: join(root, 'data'), CHRONO_PLUGIN_STATE: join(root, 'state') }
}

function itemOf(overrides = {}) {
  return {
    id: questionId('r1', 0),
    op_key: 'r1:question:c1',
    run: 'r1',
    session: 'c1',
    thread: 't1',
    questions: [{ id: 'q1', question: 'Q?' }],
    answers: null,
    expired: false,
    resume: { command: 'chat.resume', args: { cursor: { node_index: 4, call_id: 'c1' }, thread: 't1' } },
    at: '2023-11-14T22:13:20.000Z',
    expires_at: null,
    ...overrides,
  }
}

test('写读往返：入队项可读回，计数与到达序正确', () => {
  const root = tempRoot('roundtrip')
  try {
    const store = QuestionStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: questionId('r1', 0), op_key: 'r1:question:c1' }))
    store.turnClose('r1')
    store.turnOpen('r2')
    store.appendItem('r2', itemOf({ id: questionId('r2', 1), op_key: 'r2:question:c2', thread: 't2' }))
    store.turnClose('r2')
    assert.equal(store.count(), 2)
    assert.deepEqual(store.itemsInOrder().map((item) => item.id), ['q-r1-0', 'q-r2-1'])
    assert.deepEqual(store.get('q-r1-0').resume.args.cursor, { node_index: 4, call_id: 'c1' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('跨重启重放：游标、答案与计数从 ④ 重建', () => {
  const root = tempRoot('restart')
  try {
    const first = QuestionStore.open(envFor(root))
    first.turnOpen('r1')
    first.appendItem('r1', itemOf({ id: questionId('r1', 0), op_key: 'r1:question:c1' }))
    first.turnClose('r1')
    first.turnOpen('r2')
    first.updateItem('r2', { ...itemOf({ id: questionId('r1', 0), op_key: 'r1:question:c1' }), answers: [{ question_id: 'q1', selected: ['左'] }] })
    first.turnClose('r2')

    const second = QuestionStore.open(envFor(root))
    assert.equal(second.count(), 1)
    const item = second.get('q-r1-0')
    assert.deepEqual(item.answers, [{ question_id: 'q1', selected: ['左'] }])
    assert.deepEqual(item.resume.args.cursor, { node_index: 4, call_id: 'c1' }, '跨重启仍可取回 resume 游标')
    assert.deepEqual(second.pendingTurns(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('边跑边追加：未收口即可读；open 回合可辨为中断残留', () => {
  const root = tempRoot('append')
  try {
    const store = QuestionStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: questionId('r1', 0), op_key: 'r1:question:c1' }))
    assert.equal(store.itemsInOrder().length, 1)
    assert.deepEqual(store.pendingTurns(), ['r1'])
    store.turnClose('r1')
    assert.deepEqual(store.pendingTurns(), [])
    assert.ok(store.findByOpKey('r1:question:c1') !== null)
    assert.equal(store.count(), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('坏行 / 半写末行跳过（fail-open）', () => {
  const root = tempRoot('torn')
  try {
    const store = QuestionStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: questionId('r1', 0), op_key: 'r1:question:c1' }))
    store.turnClose('r1')
    const file = join(root, 'data', 'question.jsonl')
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"t":"write","ops":[{"op":"item","item":{"id":"q-r1-9`)

    const replayed = QuestionStore.open(envFor(root))
    assert.deepEqual(replayed.itemsInOrder().map((item) => item.id), ['q-r1-0'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('存储层不产世界 directive：question 队列无 add_gen', () => {
  const root = tempRoot('noworld')
  try {
    const store = QuestionStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: questionId('r1', 0), op_key: 'r1:question:c1' }))
    store.turnClose('r1')
    const serialized = JSON.stringify({ items: store.itemsInOrder(), count: store.count() })
    assert.equal(serialized.includes('add_gen'), false)
    assert.equal(serialized.includes('$directives'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
