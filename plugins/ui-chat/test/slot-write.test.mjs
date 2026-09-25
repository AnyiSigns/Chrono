// Input slot write command (pure module): slots are runtime records owned by the input service,
// so the UI builds an `input.write` command instead of a world write directive.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slotWriteCommand } from '../execute/web/slot-write.ts'

test('slotWriteCommand builds an input.write command for the given thread and slot', () => {
  const slot = { kind: 'question.answer', id: 'q1', answers: [] }
  const command = slotWriteCommand('t1', slot)
  assert.deepEqual(command, { name: 'input.write', args: { thread: 't1', slot } })
})
