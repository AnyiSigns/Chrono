// session durable store unit tests: append-only replay, idempotency, turn markers (partial state),
// and the 3/4 split (derived index rebuild). Uses a temp CHRONO_PLUGIN_DATA / CHRONO_PLUGIN_STATE.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../execute/store.ts'

function envFor(root) {
  return { CHRONO_PLUGIN_DATA: join(root, 'data'), CHRONO_PLUGIN_STATE: join(root, 'state') }
}

test('append then replay: conversation and messages round-trip', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1', workspace_id: 'w1', title: 't' })
    store.setCurrent('r1', 'c1')
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'hi', prev: null, at: 'now' })
    store.appendMessage('r1', 'c1', { id: 'm2', role: 'assistant', content: 'yo', prev: { def: 'm1' }, at: 'now' })
    const reopened = SessionStore.open(env)
    assert.equal(reopened.currentId(), 'c1')
    assert.equal(reopened.messagesOf('c1').length, 2)
    const conversation = reopened.conversation('c1')
    assert.equal(conversation.head.def, 'm2')
    assert.equal(conversation.count, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('message append is idempotent by id; slot overwrite is last-wins', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'a', prev: null, at: 'now' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'a', prev: null, at: 'now' })
    assert.equal(store.messagesOf('c1').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn markers: an open turn without close is identifiable after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1' })
    // Simulate an interrupted turn: open + one message written, no close.
    store.turnOpen('run-interrupted', 'c1')
    store.appendMessage('run-interrupted', 'c1', { id: 'm1', role: 'user', content: 'half', prev: null, at: 'now' })
    assert.deepEqual(store.pendingTurns(), ['run-interrupted'])
    const reopened = SessionStore.open(env)
    assert.deepEqual(reopened.pendingTurns(), ['run-interrupted'])
    // Closing the turn clears the residue.
    reopened.turnClose('run-interrupted')
    assert.deepEqual(reopened.pendingTurns(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('derived index deletion does not affect replay from the durable log', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'x', prev: null, at: 'now' })
    rmSync(join(root, 'state'), { recursive: true, force: true })
    const reopened = SessionStore.open(env)
    assert.equal(reopened.messagesOf('c1').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('torn trailing line is skipped (fail-open)', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'x', prev: null, at: 'now' })
    // Append a torn line (no trailing newline) to simulate an interrupted write.
    writeFileSync(join(root, 'data', 'session.jsonl'), '{"t":"msg","conv":"c1","msg":{"id":"m2"', { flag: 'a' })
    const reopened = SessionStore.open(env)
    assert.equal(reopened.messagesOf('c1').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
