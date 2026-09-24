// 输入槽写指令（纯模块）：有数据世代写 slots 补丁 + base；无 / 空改动回落整份。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slotWriteDirective } from '../execute/web/slot-write.ts'

test('输入槽写指令：有 data_gen 写补丁 + base；无 / 空改动回落整份', () => {
  const prev = { slots: { t1: { kind: 'chat.message', text: 'hi' } } }
  const slot = { kind: 'question.answer', id: 'q1', answers: [] }

  const patched = slotWriteDirective(prev, 't1', slot, undefined, { seq: 6, payload: 'a'.repeat(64) })
  const ops = patched.request.args.ops
  assert.equal(ops[1].args.id, 'input')
  assert.equal(ops[1].args.base, 6)
  assert.deepEqual(ops[0].args.body.ops, [{ op: 'replace', path: ['slots', 't1'], value: slot }])

  const full = slotWriteDirective(prev, 't1', slot)
  assert.equal(full.request.args.ops[1].args.base, undefined)
  assert.equal(Array.isArray(full.request.args.ops[0].args.body.ops), false)

  const empty = slotWriteDirective({ slots: { t1: slot } }, 't1', slot, undefined, { seq: 6 })
  assert.equal(empty.request.args.ops[1].args.base, undefined)
  assert.equal(Array.isArray(empty.request.args.ops[0].args.body.ops), false)

  const active = slotWriteDirective(prev, 't1', slot, 'b'.repeat(64))
  assert.equal(active.request.args.ops[1].args.expect_active, 'b'.repeat(64))
})
