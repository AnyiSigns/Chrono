// 队列写口归门面拥有：`note-input` / `promote-input` 转发给 session 持久存储并回传其结果。
// 消费方（chat）不再硬连 session 的队列词汇；此处验门面侧的转发与失败分码。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

test('note-input 转发 session.turn_note_input 并回传其值', async () => {
  const seen = []
  const service = startService({
    providers: {
      'session.turn_note_input': (args) => {
        seen.push(args)
        return { ok: true, turn_id: args.turn_id, noted: true }
      },
    },
  })
  try {
    const frame = await service.call('loop-policy', 'note-input', {
      turn_id: 't1',
      insert_id: 'i1',
      user_message: { role: 'user', content: 'x' },
    })
    assert.equal(frame.kind, 'result', JSON.stringify(frame))
    assert.deepEqual(frame.value, { ok: true, turn_id: 't1', noted: true })
    assert.deepEqual(seen, [
      { turn_id: 't1', insert_id: 'i1', user_message: { role: 'user', content: 'x' } },
    ])
  } finally {
    service.close()
  }
})

test('promote-input 转发 session.turn_promote_input 并回传其值', async () => {
  const service = startService({
    providers: {
      'session.turn_promote_input': (args) => ({ ok: true, turn_id: args.turn_id, promoted: 2 }),
    },
  })
  try {
    const frame = await service.call('loop-policy', 'promote-input', { turn_id: 't1' })
    assert.equal(frame.kind, 'result', JSON.stringify(frame))
    assert.deepEqual(frame.value, { ok: true, turn_id: 't1', promoted: 2 })
  } finally {
    service.close()
  }
})

test('会话不可达：note-input 上报 session_unavailable', async () => {
  const service = startService({
    providers: {
      'session.turn_note_input': () => ({ __error: { code: 'down', message: 'session down' } }),
    },
  })
  try {
    const frame = await service.call('loop-policy', 'note-input', {
      turn_id: 't1',
      insert_id: 'i1',
      user_message: { role: 'user', content: 'x' },
    })
    assert.equal(frame.kind, 'error', JSON.stringify(frame))
    assert.equal(frame.code, 'session_unavailable')
  } finally {
    service.close()
  }
})
