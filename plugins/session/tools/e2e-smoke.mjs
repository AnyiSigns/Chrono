// session durable-store E2E (black-box, service protocol level):
// spawn `execute/main.ts` with a temp CHRONO_PLUGIN_DATA / CHRONO_PLUGIN_STATE, answer the
// reverse `input.clear` call, then drive new_conversation -> commit -> read -> history and assert
// the records round-trip. The service returns plain values (no world write directives).
// Usage: node plugins/session/tools/e2e-smoke.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'e2e-run', thread: 't1', now: 1_700_000_000_000 }

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

function startService(root) {
  const env = {
    ...process.env,
    CHRONO_PLUGIN_DATA: join(root, 'data'),
    CHRONO_PLUGIN_STATE: join(root, 'state'),
  }
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env })
  const decoder = createDecoder()
  const pending = new Map()
  const portCalls = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'port.call') {
        portCalls.push(message)
        child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true } }))
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', () => {})
  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `e2e-${seq}`
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => rejectRequest(new Error(`timeout waiting ${expect} for ${kind}`)), 8000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.kind !== expect) {
          rejectRequest(new Error(`expected ${expect} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }
  return {
    child,
    portCalls,
    exit,
    request,
    call: async (method, args, env = FIXED_ENV) => {
      const message = await request('call', { port: 'session', method, args, env }, 'result')
      return message.value
    },
    close: () => child.stdin.end(),
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'chrono-session-e2e-'))
  mkdirSync(join(root, 'state'), { recursive: true })
  const drv = startService(root)
  try {
    await drv.request('hello', { impl: 'session', gen: 'e2e' }, 'manifest')
    const created = await drv.call('new_conversation', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.new', workspace_id: 'w1' } } },
      conversation_id: 'c1',
      workspace_id: 'w1',
    })
    assert.equal(created.ok, true)
    const committed = await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'hello' } } },
      conversation: 'c1',
      user: { content: 'hello' },
      assistant: { content: 'world' },
    })
    assert.equal(committed.ok, true)
    assert.equal('$directives' in committed, false, 'runtime records must not produce world plans')
    const read = await drv.call('read', { conversation: 'c1' })
    const conversation = read.conversations.find((item) => item.id === 'c1')
    assert.equal(conversation.count, 2)
    const bodies = Object.values(read.refs)
    assert.equal(bodies[0].role, 'user')
    assert.equal(bodies[1].role, 'assistant')
    assert.deepEqual(bodies[1].prev, { def: bodies[0].id })
    const history = await drv.call('history', { conversation: 'c1' })
    assert.deepEqual(history.messages.map((entry) => entry.def.role), ['assistant', 'user'])
    assert.ok(drv.portCalls.some((frame) => frame.port === 'input' && frame.method === 'clear'))
    console.log('durable round-trip: commit -> read -> history ok; input.clear called; no world plan')
    console.log(`E2E ok (root=${root})`)
  } finally {
    drv.close()
    await drv.exit
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // cleanup failure does not change the verdict
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
