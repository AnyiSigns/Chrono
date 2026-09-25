// input plugin tests (node --test): package shape + service protocol level.
// Input slots are runtime records owned by this identity's durable service (CHRONO_PLUGIN_DATA);
// the service returns plain slot bodies, never world write plans.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))
const ENTRY = join(pkgRoot, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

const DECL_FIELDS = [
  'identity',
  'schema',
  'implements',
  'methods',
  'pins',
  'start',
  'protocol',
  'restart',
  'health',
  'state',
  'exclusive',
  'members',
  'commands',
]

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
])
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples'])

function assertWhitelist(schema, where) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), where)
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue
    assert.ok(KEYWORDS.has(key), `${where}.${key} not in whitelist`)
    const value = schema[key]
    switch (key) {
      case 'type':
        assert.equal(typeof value, 'string', `${where}.type`)
        assert.ok(TYPES.has(value), `${where}.type invalid: ${value}`)
        break
      case 'properties':
        for (const [name, child] of Object.entries(value)) assertWhitelist(child, `${where}.properties.${name}`)
        break
      case 'items':
        assertWhitelist(value, `${where}.items`)
        break
      case 'required':
        assert.ok(Array.isArray(value) && value.every((x) => typeof x === 'string'), where)
        break
      case 'additionalProperties':
        assert.equal(typeof value, 'boolean', `${where}.additionalProperties must be boolean`)
        break
      case 'enum':
        assert.ok(Array.isArray(value) && value.length > 0, `${where}.enum`)
        break
      case 'minimum':
      case 'maximum':
        assert.equal(typeof value, 'number', `${where}.${key}`)
        break
      case 'minItems':
      case 'maxItems':
      case 'minLength':
      case 'maxLength':
        assert.ok(Number.isInteger(value) && value >= 0, `${where}.${key}`)
        break
      default:
        break
    }
  }
}

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

function startService(options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'chrono-input-'))
  const env = {
    ...process.env,
    CHRONO_PLUGIN_DATA: join(root, 'data'),
    CHRONO_PLUGIN_STATE: join(root, 'state'),
  }
  const child = spawn(process.execPath, [ENTRY], { cwd: pkgRoot, stdio: ['pipe', 'pipe', 'pipe'], env })
  const decoder = createDecoder()
  const pending = new Map()
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
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
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }
  return {
    root,
    exit,
    request,
    hello: () => request('hello', { impl: 'input', gen: 'gen-1' }, 'manifest'),
    call: async (method, args, env = FIXED_ENV) => {
      const message = await request('call', { port: 'input', method, args, env }, 'result')
      return message.value
    },
    callRaw: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'input', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // cleanup failure does not change the verdict
      }
    },
  }
}

// -- package shape -----------------------------------------------------------

test('plugin.json fields complete and well-formed', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'input')
  assert.equal(decl.schema, 'schema/slot.schema.json')
  assert.deepEqual(decl.implements, ['input'])
  assert.deepEqual(decl.methods, { input: ['read', 'write', 'clear'] })
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'durable')
  assert.deepEqual(decl.exclusive, ['data'])
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
    { kind: 'schema', path: 'schema/' },
  ])
})

test('commands declare input.read (readonly) and input.write', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.commands.map((c) => c.name), ['input.read', 'input.write'])
  const read = decl.commands[0]
  assert.equal(read.entry, 'terms/input.read.json')
  assert.equal(read.argsSchema, 'schema/input.read.args.json')
  assert.equal(read.readonly, true)
  const write = decl.commands[1]
  assert.equal(write.entry, 'terms/input.write.json')
  assert.equal(write.argsSchema, 'schema/input.write.args.json')
})

test('slot schema is valid JSON and within the whitelist subset', () => {
  assertWhitelist(readJson('schema/slot.schema.json'), 'slot.schema')
})

test('slot schema requires slots with boolean additionalProperties', () => {
  const schema = readJson('schema/slot.schema.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['slots'])
  assert.equal(typeof schema.additionalProperties, 'boolean')
  assert.equal(schema.properties.slots.type, 'object')
})

test('slot schema keeps the kind enum and slot fields', () => {
  const props = readJson('schema/slot.schema.json').properties.slot.properties
  assert.deepEqual(props.kind.enum, [
    'chat.message',
    'session.new',
    'session.select',
    'session.rename',
    'session.delete',
    'session.restore',
    'session.branch',
    'model.probe',
    'approval.decide',
    'question.answer',
    'workspace.add',
    'workspace.remove',
    'memory.edit',
    'idle',
  ])
  for (const field of ['kind', 'text', 'attachments', 'conversation', 'title', 'message', 'id', 'verdict', 'answers', 'action', 'layer', 'patch']) {
    assert.ok(Object.hasOwn(props, field), `missing slot field ${field}`)
  }
})

test('input.read / input.write argsSchema within whitelist', () => {
  assertWhitelist(readJson('schema/input.read.args.json'), 'input.read.args')
  assertWhitelist(readJson('schema/input.write.args.json'), 'input.write.args')
  assert.deepEqual(readJson('schema/input.write.args.json').required, ['slot'])
})

test('terms route to the input service (self-capability eff with args)', () => {
  assert.deepEqual(readJson('terms/input.read.json'), ['eff', 'input', 'read', ['v', 0]])
  assert.deepEqual(readJson('terms/input.write.json'), ['eff', 'input', 'write', ['v', 0]])
})

test('.worldignore excludes test/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
})

test('package.json has no deps and a test script', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

// -- service protocol --------------------------------------------------------

test('hello returns manifest: durable state', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'input')
    assert.deepEqual(manifest.implements, ['input'])
    assert.equal(manifest.state, 'durable')
    assert.deepEqual(manifest.methods.input, ['read', 'write', 'clear'])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('read returns empty slots; write then read round-trips', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.deepEqual(await drv.call('read', {}), { slots: {} })
    const wrote = await drv.call('write', { thread: 't1', slot: { kind: 'chat.message', text: 'hi' } })
    assert.equal(wrote.ok, true)
    const read = await drv.call('read', { thread: 't1' })
    assert.deepEqual(read.slots.t1, { kind: 'chat.message', text: 'hi' })
    assert.deepEqual(read.slot, { kind: 'chat.message', text: 'hi' })
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write is idempotent for identical slot; clear sets idle for one thread only', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('write', { thread: 't1', slot: { kind: 'chat.message', text: 'a' } }, { run: 'r1', thread: 't1', now: 1 })
    await drv.call('write', { thread: 't2', slot: { kind: 'chat.message', text: 'b' } }, { run: 'r1', thread: 't1', now: 1 })
    await drv.call('write', { thread: 't1', slot: { kind: 'chat.message', text: 'a' } }, { run: 'r1', thread: 't1', now: 1 })
    await drv.call('clear', { thread: 't1' })
    const read = await drv.call('read', {})
    assert.deepEqual(read.slots.t1, { kind: 'idle' })
    assert.deepEqual(read.slots.t2, { kind: 'chat.message', text: 'b' })
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('3/4 split: deleting CHRONO_PLUGIN_STATE still replays slots from the durable store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-input-'))
  const first = startService({ root })
  try {
    await first.hello()
    await first.call('write', { thread: 't1', slot: { kind: 'chat.message', text: 'persisted' } })
  } finally {
    first.close()
    await first.exit
  }
  rmSync(join(root, 'state'), { recursive: true, force: true })
  const second = startService({ root })
  try {
    await second.hello()
    assert.deepEqual((await second.call('read', {})).slots.t1, { kind: 'chat.message', text: 'persisted' })
  } finally {
    second.close()
    await second.exit
    second.cleanup()
  }
})

test('write without slot -> bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.callRaw('write', { thread: 't1' })
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'bad_args')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('README exists and does not reference plan documents', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README contains plan-number style #<digit>')
  assert.ok(!readme.includes('docs/plans'), 'README references plan documents')
})
