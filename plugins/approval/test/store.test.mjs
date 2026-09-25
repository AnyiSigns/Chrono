// `approval` 自有持久存储测试（node --test）：写读往返、边跑边追加、同回合幂等、跨重启重放、中断残留可辨、
// 世界不新增世代（存储层不产 directive）。直接驱动 store（不经协议），验证 ④ 引擎性质。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ApprovalStore, approvalId } from '../execute/store.ts'

function tempRoot(label) {
  return mkdtempSync(join(tmpdir(), `approval-store-${label}-`))
}

function envFor(root) {
  return { CHRONO_PLUGIN_DATA: join(root, 'data'), CHRONO_PLUGIN_STATE: join(root, 'state') }
}

function itemOf(overrides = {}) {
  return {
    id: approvalId('r1', 0),
    op_key: 'r1:approval:3',
    kind: 'tool_call',
    port: 'tool-shell',
    status: 'pending',
    thread: 't1',
    at: '2023-11-14T22:13:20.000Z',
    decided_at: null,
    by: null,
    resume: { command: 'chat.resume', args: { cursor: { node_index: 3 }, thread: 't1' } },
    shadow: null,
    ...overrides,
  }
}

test('写读往返：入队项可读回，计数与到达序正确', () => {
  const root = tempRoot('roundtrip')
  try {
    const store = ApprovalStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: approvalId('r1', 0), op_key: 'r1:approval:3' }))
    store.turnClose('r1')
    store.turnOpen('r2')
    store.appendItem('r2', itemOf({ id: approvalId('r2', 1), op_key: 'r2:approval:3', thread: 't2' }))
    store.turnClose('r2')

    assert.equal(store.count(), 2)
    assert.deepEqual(store.itemsInOrder().map((item) => item.id), ['ap-r1-0', 'ap-r2-1'])
    assert.deepEqual(store.get('ap-r1-0').resume.args.cursor, { node_index: 3 })
    assert.equal(store.size(), 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('跨重启重放：游标与计数从 ④ 重建（新实例读到同一队列）', () => {
  const root = tempRoot('restart')
  try {
    const first = ApprovalStore.open(envFor(root))
    first.turnOpen('r1')
    first.appendItem('r1', itemOf({ id: approvalId('r1', 0), op_key: 'r1:approval:3' }))
    first.turnClose('r1')
    first.turnOpen('r1')
    first.updateItem('r1', { ...itemOf({ id: approvalId('r1', 0), op_key: 'r1:approval:3' }), status: 'approved', by: 'user' })
    first.turnClose('r1')

    // 模拟宿主重启：新实例从同一 ④ 目录重放。
    const second = ApprovalStore.open(envFor(root))
    assert.equal(second.count(), 1)
    assert.equal(second.itemsInOrder().length, 1)
    const item = second.get('ap-r1-0')
    assert.equal(item.status, 'approved')
    assert.equal(item.by, 'user')
    assert.deepEqual(item.resume.args.cursor, { node_index: 3 }, '跨重启仍可取回 resume 游标')
    assert.deepEqual(second.pendingTurns(), [], '已闭合回合无残留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('边跑边追加：未收口即可读；同 op_key 重复入队幂等收敛（不重复计数）', () => {
  const root = tempRoot('append')
  try {
    const store = ApprovalStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: approvalId('r1', 0), op_key: 'r1:approval:3' }))
    // 回合尚未 close，项已可读（边跑边追加）。
    assert.equal(store.itemsInOrder().length, 1)
    assert.deepEqual(store.pendingTurns(), ['r1'], 'open 回合可辨为中断残留')
    store.turnClose('r1')
    assert.deepEqual(store.pendingTurns(), [])

    // 同 op_key 重复入队：调用方先查 findByOpKey，命中即不追加。
    assert.ok(store.findByOpKey('r1:approval:3') !== null)
    assert.equal(store.findByOpKey('r1:approval:other'), null)
    assert.equal(store.count(), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('归档：dropItems 从活动队列移除，重放后仍不复活', () => {
  const root = tempRoot('archive')
  try {
    const store = ApprovalStore.open(envFor(root))
    for (let index = 0; index < 3; index++) {
      store.turnOpen('r1')
      store.appendItem('r1', itemOf({ id: approvalId('r1', index), op_key: `r1:approval:${index}` }))
      store.turnClose('r1')
    }
    store.dropItems('r1', ['ap-r1-0'])
    assert.deepEqual(store.itemsInOrder().map((item) => item.id), ['ap-r1-1', 'ap-r1-2'])

    const replayed = ApprovalStore.open(envFor(root))
    assert.deepEqual(replayed.itemsInOrder().map((item) => item.id), ['ap-r1-1', 'ap-r1-2'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('坏行 / 半写末行跳过（fail-open），已确认前缀照常可用', () => {
  const root = tempRoot('torn')
  try {
    const store = ApprovalStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: approvalId('r1', 0), op_key: 'r1:approval:3' }))
    store.turnClose('r1')
    const file = join(root, 'data', 'approval.jsonl')
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"t":"write","ops":[{"op":"item","item":{"id":"ap-r1-9`)

    const replayed = ApprovalStore.open(envFor(root))
    assert.deepEqual(replayed.itemsInOrder().map((item) => item.id), ['ap-r1-0'], '撕裂末行被截掉')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('存储层不产世界 directive：approval 队列无 add_gen（世界不新增世代）', () => {
  const root = tempRoot('noworld')
  try {
    const store = ApprovalStore.open(envFor(root))
    store.turnOpen('r1')
    store.appendItem('r1', itemOf({ id: approvalId('r1', 0), op_key: 'r1:approval:3' }))
    store.turnClose('r1')
    // 存储 API 只回 void / 项；不存在任何 `$directives` / `add_gen` 形状的返回值。
    const serialized = JSON.stringify({ items: store.itemsInOrder(), count: store.count() })
    assert.equal(serialized.includes('add_gen'), false)
    assert.equal(serialized.includes('$directives'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
