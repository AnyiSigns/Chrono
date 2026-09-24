// `question` 服务协议级测试（node --test）：自实现最小协议驱动，spawn `node execute/main.ts`。
// 覆盖 describe 四要素 / render / caps；invoke 入队计划形状（item 链式 prev、resume 游标、不清槽）；
// question.pending 在入队计划产出时发；list 读队列；sweep 标 expired；
// 作答命令路径（按 id 沿 tail 链定位 → 产续跑计划 + 清槽，per-thread 键控）；
// 并用测试内联的最小求值器求值 terms/question.answer.json（预置 eff 回灌），验证入口 term 形状与占位正确。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
// 红线断言（包形状）；本包 test 脚本按文件显式列出，故在此引入使其随 npm test 执行。
import './package.test.mjs'
import { createHandlers } from '../execute/methods.ts'
import { pushInputGen } from '../execute/plan.ts'
import { DefUnavailableError } from '../execute/refs.ts'

// ── 测试内联最小内核助手（测试不得 import 宿主与内核包） ──────────────────────

/** 规范序列化：键升序、剔除 undefined 键、-0 归一（与内核 canonicalJson 同口径）。 */
function canonical(value) {
  if (value === undefined) throw new Error('undefined')
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value === 0 ? 0 : value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

/** 内容哈希：hex(sha256(utf8(canonicalJson(v))))，全 64 个十六进制字符。 */
function H(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

function walk(value, path) {
  let current = value
  for (const step of path) current = current[step]
  return current
}

/** 最小补丁组装（测试内联，避免引用内核包）：replace / delete 两种 op。 */
function applyOps(base, ops) {
  const doc = structuredClone(base)
  for (const op of ops) {
    let node = doc
    for (let i = 0; i < op.path.length - 1; i++) node = node[op.path[i]]
    const last = op.path[op.path.length - 1]
    if (op.op === 'delete') {
      if (Array.isArray(node)) node.splice(last, 1)
      else delete node[last]
    } else {
      node[last] = structuredClone(op.value)
    }
  }
  return doc
}

/** 最小求值器：只覆盖本测试用到的 `c` / `g` / `v` / `eff`（eff 走 env.results 回灌）。 */
function evalNode(term, env) {
  if (!Array.isArray(term)) throw new Error('bad_term')
  const tag = term[0]
  if (tag === 'c') return term[1]
  if (tag === 'g') return walk(env.ctx, term[1])
  if (tag === 'v') return env.args[term[1]]
  if (tag === 'eff') {
    const argValue = evalNode(term[3], env)
    const id = H({ run: env.run, i: env.i, n: env.n })
    env.n += 1
    const result = env.results[id]
    if (result === undefined) throw new Error('suspend')
    if (!result.ok) throw new Error('eff_error')
    return result.value
  }
  throw new Error('bad_term')
}

function evalTerm(term, env) {
  try {
    return { ok: true, value: evalNode(term, env) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const PAST = 1_600_000_000_000

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
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        options.onPortCall?.(message, (reply) => child.stdin.write(encodeFrame(reply)))
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
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, 8000)
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
    child,
    events,
    exit,
    request,
    hello: () => request('hello', { impl: 'question', gen: 'gen-1' }, 'manifest'),
    call: async (method, args, env = FIXED_ENV) =>
      (await request('call', { port: 'question', method, args, env }, ['result', 'error'])).value,
    close: () => child.stdin.end(),
  }
}

function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

function opsOf(value) {
  const batch = directivesOf(value).find((item) => item.kind === 'write')
  return Array.isArray(batch?.request?.args?.ops) ? batch.request.args.ops : []
}

function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  return extern?.payload ?? null
}

function question(id = 'q1', extra = {}) {
  return { id, header: '顶栏位置', question: '放哪里？', options: [{ label: '左' }, { label: '右' }], multiple: false, custom: true, ...extra }
}

function itemFixture(overrides = {}) {
  return {
    id: 'q-run-1-0',
    run: 'run-1',
    session: 'c1',
    thread: 't1',
    questions: [question()],
    answers: null,
    expired: false,
    resume: { command: 'chat.resume', args: { cursor: 'cur-9', thread: 't1' } },
    at: '2023-11-14T22:13:20.000Z',
    expires_at: null,
    prev: null,
    ...overrides,
  }
}

// ── 握手 / 声明 ────────────────────────────────────────────────────────────

test('hello 回 manifest：能力类与方法声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'question')
    assert.deepEqual(manifest.implements, ['question'])
    assert.deepEqual(manifest.methods.question, ['describe', 'invoke', 'list', 'sweep'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
  } finally {
    drv.close()
  }
})

test('plugin.json / schema / .worldignore 声明口径', () => {
  const plugin = JSON.parse(readFileSync(join(PKG_ROOT, 'plugin.json'), 'utf8'))
  assert.equal(plugin.identity, 'question')
  assert.deepEqual(plugin.implements, ['question'])
  assert.deepEqual(plugin.pins, { host: 'host' })
  assert.deepEqual(plugin.methods.question, ['describe', 'invoke', 'list', 'sweep'])
  const kinds = plugin.members.map((member) => member.kind).sort()
  assert.deepEqual(kinds, ['execute', 'schema', 'term'])
  assert.equal(plugin.commands[0].name, 'question.answer')
  assert.equal(plugin.commands[0].entry, 'terms/question.answer.json')
  assert.equal(plugin.commands[0].argsSchema, 'schema/question.answer.args.json')

  const schema = JSON.parse(readFileSync(join(PKG_ROOT, 'schema', 'question.json'), 'utf8'))
  assert.equal(schema.periodic[0].method, 'sweep')
  assert.equal(schema.periodic[0].reads.queue.join('.'), 'ids.question.body')
  assert.equal(schema.periodic[0].reads.refs.join('.'), 'ids.question.refs')

  const worldignore = readFileSync(join(PKG_ROOT, '.worldignore'), 'utf8')
  assert.match(worldignore, /^test\/$/m)
  assert.match(worldignore, /^tools\/$/m)

  // 入口 term：eff 自身 invoke、args = ctx.ids（投影读在 term，服务不读投影）
  const term = JSON.parse(readFileSync(join(PKG_ROOT, 'terms', 'question.answer.json'), 'utf8'))
  assert.deepEqual(term, ['eff', 'question', 'invoke', ['g', ['ids']]])
})

// ── describe ───────────────────────────────────────────────────────────────

test('describe：工具 question + 四要素 + render.detail.kind=question + caps/idempotent', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('describe', {})
    const tool = value.tools[0]
    assert.equal(tool.name, 'question')
    for (const field of ['intent', 'when_to_use', 'param_semantics', 'boundaries']) {
      assert.ok(tool[field] !== undefined && tool[field] !== '', `missing ${field}`)
    }
    for (const key of tool.argsSchema.required ?? []) {
      assert.ok(tool.param_semantics[key] !== undefined, `param_semantics missing ${key}`)
    }
    assert.equal(tool.caps.fs.read, 'none')
    assert.equal(tool.caps.fs.write, 'none')
    assert.equal(tool.caps.net, 'none')
    assert.equal(tool.idempotent, false)
    assert.equal(tool.render.form, 'card')
    assert.equal(tool.render.label, 'question')
    assert.equal(tool.render.detail.kind, 'question')
  } finally {
    drv.close()
  }
})

// ── invoke 入队 ─────────────────────────────────────────────────────────────

test('invoke(question)：入队计划 item 链式 prev / resume 游标 / 不清槽 + pending 事件', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      session: 'c1',
      thread: 't1',
      cursor: 'cur-1',
      run: 'run-1',
      queue: { version: 1, tail: null, count: 0 },
    })
    assert.equal(value.ok, true)
    const plan = value.result
    const ops = opsOf(plan)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'put', 'add_gen'])
    const item = ops[0].args.body
    assert.equal(item.id, 'q-run-1-0')
    assert.equal(item.prev, null)
    assert.equal(item.answers, null)
    assert.equal(item.expired, false)
    assert.equal(item.session, 'c1')
    assert.equal(item.thread, 't1')
    assert.deepEqual(item.resume, { command: 'chat.resume', args: { cursor: 'cur-1', thread: 't1' } })
    assert.equal(item.expires_at, '2023-11-14T22:23:20.000Z')
    assert.deepEqual(ops[1].args.body.tail, { def: { $n: 0 } })
    assert.equal(ops[1].args.body.count, 1)
    assert.equal(ops[2].args.id, 'question')
    assert.deepEqual(ops[2].args.payload, { $n: 1 })
    // 工具不消费 #1 槽：计划里不得出现对 input 的写
    assert.equal(ops.some((op) => op.args?.id === 'input'), false)

    const payload = externOf(plan)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'pending')
    assert.equal(payload.render.detail.kind, 'question')
    assert.equal(payload.render.detail.id, 'q-run-1-0')
    assert.equal(payload.render.detail.expired, false)
    assert.equal(payload.render.detail.answers, null)

    const pending = drv.events.find((event) => event.topic === 'question.pending')
    assert.ok(pending, '应发 question.pending')
    assert.equal(pending.payload.run, 'run-1')
    assert.equal(pending.payload.thread, 't1')
    assert.equal(pending.payload.id, 'q-run-1-0')
  } finally {
    drv.close()
  }
})

test('invoke(question)：session 取会话 id（投影切片 / session_id 直给），非 null', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const slice = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      session: { body: { current: 'c-9', conversations: [] }, refs: {} },
      thread: 't1',
      cursor: 'cur-5',
      queue: { version: 1, tail: null, count: 0 },
    })
    assert.equal(opsOf(slice.result)[0].args.body.session, 'c-9')

    const direct = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      session_id: 'c-7',
      thread: 't1',
      cursor: 'cur-6',
      queue: { version: 1, tail: null, count: 0 },
    })
    assert.equal(opsOf(direct.result)[0].args.body.session, 'c-7')
  } finally {
    drv.close()
  }
})

test('invoke(question)：已有队列 → item.prev 指链头、seq 取入队前 count', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      thread: 't1',
      cursor: 'cur-2',
      queue: { version: 1, tail: { def: H1 }, count: 3 },
    })
    const ops = opsOf(value.result)
    assert.equal(ops[0].args.body.id, 'q-run-1-3')
    assert.deepEqual(ops[0].args.body.prev, { def: H1 })
    assert.equal(ops[1].args.body.count, 4)
  } finally {
    drv.close()
  }
})

test('invoke(question)：接受 {question:{body,refs}} 切片（#33 dispatch bag 转发形状），不重置队列', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      thread: 't1',
      cursor: 'cur-4',
      question: { body: { version: 1, tail: { def: H1 }, count: 3 }, refs: {} },
    })
    const ops = opsOf(value.result)
    assert.equal(ops[0].args.body.id, 'q-run-1-3')
    assert.deepEqual(ops[0].args.body.prev, { def: H1 })
    assert.equal(ops[1].args.body.count, 4)
  } finally {
    drv.close()
  }
})

test('invoke(question)：多问题 / 多选 / 自定义输入都保留', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('invoke', {
      tool: 'question',
      args: {
        questions: [
          { id: 'q1', header: 'A', question: '选哪些？', options: [{ label: 'x' }, { label: 'y' }], multiple: true, custom: true },
          { id: 'q2', header: 'B', question: '补充说明？', options: [] },
        ],
      },
      thread: 't1',
      cursor: 'cur-3',
      queue: { version: 1, tail: null, count: 0 },
    })
    const questions = opsOf(value.result)[0].args.body.questions
    assert.equal(questions.length, 2)
    assert.equal(questions[0].multiple, true)
    assert.equal(questions[0].custom, true)
    assert.deepEqual(questions[1].options, [])
    assert.equal(questions[1].multiple, false)
  } finally {
    drv.close()
  }
})

test('invoke(question)：越界 / 缺字段回结构化错误、不产写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const tooMany = await drv.call('invoke', {
      tool: 'question',
      args: { questions: Array.from({ length: 9 }, (_, index) => question(`q${index}`)) },
      queue: { version: 1, tail: null, count: 0 },
    })
    assert.equal(tooMany.ok, false)
    assert.equal(tooMany.error.code, 'too_many_questions')

    const noId = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [{ question: 'Q?' }] },
      queue: { version: 1, tail: null, count: 0 },
    })
    assert.equal(noId.error.code, 'missing_question_id')

    const unknown = await drv.call('invoke', { tool: 'nope', args: {} })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_tool')
  } finally {
    drv.close()
  }
})

// ── list ───────────────────────────────────────────────────────────────────

test('list：读队列，新版本在前、返回 oldest→newest', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const answered = itemFixture({ id: 'q-run-1-1', answers: [{ question_id: 'q1', selected: ['左'] }], prev: { def: H1 } })
    const value = await drv.call('list', {
      question: { body: { version: 1, tail: { def: H2 }, count: 2 }, refs: { [H1]: itemFixture(), [H2]: answered } },
    })
    const payload = externOf(value)
    assert.equal(payload.count, 2)
    assert.deepEqual(payload.items.map((item) => item.id), ['q-run-1-0', 'q-run-1-1'])
    assert.equal(payload.answered, 1)
  } finally {
    drv.close()
  }
})

// ── sweep ──────────────────────────────────────────────────────────────────

test('sweep：过期项标 expired（链式追加、count 不变），未到期不动', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const expired = itemFixture({ id: 'q-run-1-0', expires_at: new Date(PAST).toISOString() })
    const fresh = itemFixture({ id: 'q-run-1-1', expires_at: new Date(PAST + 10_000_000).toISOString(), prev: { def: H1 } })
    const value = await drv.call(
      'sweep',
      {
        queue: { version: 1, tail: { def: H2 }, count: 2 },
        refs: { [H1]: expired, [H2]: fresh },
      },
      { run: null, thread: null, now: PAST + 1 },
    )
    const payload = externOf(value)
    assert.equal(payload.expired, 1)
    const ops = opsOf(value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'put', 'add_gen'])
    assert.equal(ops[0].args.body.id, 'q-run-1-0')
    assert.equal(ops[0].args.body.expired, true)
    assert.deepEqual(ops[0].args.body.prev, { def: H2 })
    assert.deepEqual(ops[1].args.body.tail, { def: { $n: 0 } })
    assert.equal(ops[1].args.body.count, 2)

    const none = await drv.call(
      'sweep',
      { queue: { version: 1, tail: { def: H2 }, count: 2 }, refs: { [H1]: expired, [H2]: fresh } },
      { run: null, thread: null, now: PAST - 1 },
    )
    assert.equal(externOf(none).changed, false)
    assert.equal(directivesOf(none).some((item) => item.kind === 'write'), false)
  } finally {
    drv.close()
  }
})

// ── 作答命令路径 ───────────────────────────────────────────────────────────

test('answer：按 id 沿 tail 链定位 → eval(chat.resume) + write(记答案 + 清槽，per-thread)', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const item = itemFixture()
    const inputBody = {
      slots: {
        t1: { kind: 'question.answer', id: 'q-run-1-0', answers: [{ question_id: 'q1', selected: ['左'] }] },
        other: { kind: 'chat.message', text: 'keep' },
      },
    }
    const ids = {
      input: { body: inputBody },
      question: { body: { version: 1, tail: { def: H1 }, count: 1 }, refs: { [H1]: item } },
    }
    const value = await drv.call('invoke', ids)
    const directives = directivesOf(value)
    assert.deepEqual(directives.map((item) => item.kind), ['eval', 'write', 'extern'])
    assert.deepEqual(directives[0], {
      kind: 'eval',
      command: 'chat.resume',
      args: { cursor: 'cur-9', thread: 't1', payload: { answers: [{ question_id: 'q1', selected: ['左'] }] } },
      inject: { ids: ['ids'] },
    })
    const ops = opsOf(value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'put', 'add_gen', 'put', 'add_gen'])
    assert.deepEqual(ops[0].args.body.answers, [{ question_id: 'q1', selected: ['左'] }])
    assert.deepEqual(ops[0].args.body.prev, { def: H1 })
    assert.equal(ops[1].args.body.count, 1)
    assert.equal(ops[2].args.id, 'question')
    // 清槽：只清本线程键，其余键原样
    assert.deepEqual(ops[3].args.body.slots.t1, { kind: 'idle' })
    assert.deepEqual(ops[3].args.body.slots.other, { kind: 'chat.message', text: 'keep' })
    assert.equal(ops[4].args.id, 'input')
    assert.equal(externOf(value).status, 'answered')
  } finally {
    drv.close()
  }
})

test('answer：无槽 → no_slot 且不写；id 找不到 → 结构化拒 + 清本线程槽', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const noSlot = await drv.call('invoke', { input: { body: { slots: { t1: { kind: 'idle' } } } } })
    assert.equal(externOf(noSlot).error.code, 'no_slot')
    assert.equal(directivesOf(noSlot).some((item) => item.kind === 'write'), false)

    const missing = await drv.call('invoke', {
      input: { body: { slots: { t1: { kind: 'question.answer', id: 'q-missing', answers: [] } } } },
      question: { body: { version: 1, tail: { def: H1 }, count: 1 }, refs: { [H1]: itemFixture() } },
    })
    assert.equal(externOf(missing).error.code, 'not_found')
    const ops = opsOf(missing)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    assert.deepEqual(ops[0].args.body.slots.t1, { kind: 'idle' })
    assert.equal(ops[1].args.id, 'input')
  } finally {
    drv.close()
  }
})

// ── 入口 term 真求值（预置 eff 回灌） ──────────────────────────────────────

test('入口 term：最小求值器求值 terms/question.answer.json 得作答续跑计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const item = itemFixture()
    const ids = {
      input: {
        body: {
          slots: { t1: { kind: 'question.answer', id: 'q-run-1-0', answers: [{ question_id: 'q1', selected: ['右'] }] } },
        },
      },
      question: { body: { version: 1, tail: { def: H1 }, count: 1 }, refs: { [H1]: item } },
    }
    const expected = await drv.call('invoke', ids)
    const term = JSON.parse(readFileSync(join(PKG_ROOT, 'terms', 'question.answer.json'), 'utf8'))

    const effId = H({ run: 'run-1', i: 0, n: 0 })
    const env = {
      ctx: { ids },
      args: [],
      defs: {},
      results: { [effId]: { ok: true, value: expected } },
      caps: {},
      limits: { gas: 100000, depth: 100 },
      run: 'run-1',
      i: 0,
      n: 0,
      gas: 100000,
      depth: 0,
      peakDepth: 0,
    }
    const outcome = evalTerm(term, env)
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.deepEqual(outcome.value, expected)
    assert.equal(directivesOf(outcome.value)[0].command, 'chat.resume')
    assert.equal(directivesOf(outcome.value)[0].args.ids, undefined, '续跑不再内嵌整份投影')
    assert.deepEqual(directivesOf(outcome.value)[0].inject, { ids: ['ids'] }, '投影由宿主执行期注入')
  } finally {
    drv.close()
  }
})

// ── 引用不可用（def_unavailable） ───────────────────────────────────────────

test('hydrate：mock read 缺失 / 越权 → 抛 def_unavailable', async () => {
  const failingHost = { call: async () => ({ ok: false, code: 'denied', message: 'denied' }) }
  const handlers = createHandlers({ host: failingHost })
  await assert.rejects(
    handlers.list({ queue: { version: 1, tail: null, count: 0 }, refs: [H1] }, FIXED_ENV),
    (err) => {
      assert.ok(err instanceof DefUnavailableError)
      assert.equal(err.code, 'def_unavailable')
      assert.deepEqual(err.hashes, [H1])
      return true
    },
  )
})

// ── 补丁世代（有 data_gen 时写补丁 + base；组装结果 == 整份写入） ─────────────

test('补丁世代：enqueue 队列 body 写补丁 + base', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const queue = { version: 1, tail: null, count: 0 }
    const value = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      question: { body: queue, refs: {} },
      data_gen: { seq: 4, payload: H1 },
      run: 'r1',
      thread: 't1',
      at: '2023-11-14T22:13:20.000Z',
    })
    const ops = opsOf(value.result)
    const patchDef = ops[1].args.body
    assert.ok(Array.isArray(patchDef.ops) && patchDef.ops.length > 0)
    assert.equal(ops[2].args.id, 'question')
    assert.equal(ops[2].args.base, 4)
    assert.deepEqual(applyOps(queue, patchDef.ops), { version: 1, tail: { def: { $n: 0 } }, count: 1 })
  } finally {
    drv.close()
  }
})

test('补丁世代：answer 队列 + input 清槽各自补丁 + base', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const item = itemFixture()
    const ids = {
      input: {
        body: { slots: { t1: { kind: 'question.answer', id: 'q-run-1-0', answers: [{ question_id: 'q1', selected: ['右'] }] } } },
        data_gen: { seq: 11, payload: H1 },
      },
      question: {
        body: { version: 1, tail: { def: H1 }, count: 1 },
        refs: { [H1]: item },
        data_gen: { seq: 12, payload: H2 },
      },
    }
    const value = await drv.call('invoke', ids)
    const write = directivesOf(value).find((directive) => directive.kind === 'write')
    const ops = write.request.args.ops
    const questionGen = ops.find((op) => op.op === 'add_gen' && op.args.id === 'question')
    const inputGen = ops.find((op) => op.op === 'add_gen' && op.args.id === 'input')
    assert.equal(questionGen.args.base, 12)
    assert.equal(inputGen.args.base, 11)
    const inputPatch = ops[ops.indexOf(inputGen) - 1].args.body
    assert.deepEqual(inputPatch.ops, [{ op: 'replace', path: ['slots', 't1'], value: { kind: 'idle' } }])
  } finally {
    drv.close()
  }
})

test('补丁世代：input 空改动（已 idle）回落整份', () => {
  const ops = []
  pushInputGen(ops, { slots: { t1: { kind: 'idle' } }, data_gen: { seq: 5, payload: H1 } }, 't1')
  assert.equal(ops[1].args.base, undefined)
  assert.equal(Array.isArray(ops[0].args.body.ops), false)
})

test('服务帧：引用不可用回 def_unavailable 帧', async () => {
  const drv = startService({
    onPortCall: (message, reply) =>
      reply({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'denied', message: 'denied' }),
  })
  try {
    await drv.hello()
    const message = await drv.request(
      'call',
      {
        port: 'question',
        method: 'list',
        args: { queue: { version: 1, tail: null, count: 0 }, refs: [H1] },
        env: FIXED_ENV,
      },
      ['result', 'error'],
    )
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'def_unavailable')
  } finally {
    drv.close()
  }
})
