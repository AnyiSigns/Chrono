// `question` 服务协议级测试（node --test）：自实现最小协议驱动，spawn `node execute/main.ts`（注入临时 ④/③ 目录）。
// 覆盖 describe 四要素 / render / caps；invoke 入队（写自有存储、无世界写）；question.pending 事件；
// list 读队列；sweep 标 expired；作答命令路径（反向调 input.read / input.clear → 产续跑计划）；
// 并用测试内联的最小求值器求值 terms/question.answer.json（预置 eff 回灌），验证入口 term 形状。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'

// ── 测试内联最小内核助手（测试不得 import 宿主与内核包） ──────────────────────

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

function H(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

function walk(value, path) {
  let current = value
  for (const step of path) current = current[step]
  return current
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
    void argValue
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
const PAST = 1_600_000_000_000

/**
 * SDK 驱动适配：能力类固定；反向调用仍以 `onPortCall(message, reply)` 回调口径注入，
 * 同步 reply 转成 SDK 驱动的应答形状。
 */
function startService(options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'question-svc-'))
  let reply = null
  const drv = startSdkService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    env: {
      CHRONO_PLUGIN_DATA: join(root, 'data'),
      CHRONO_PLUGIN_STATE: join(root, 'state'),
    },
    onPortCall: (message) => {
      reply = null
      options.onPortCall?.(message, (frame) => {
        reply = frame
      })
      if (reply === null) return { ok: true, value: null }
      if (reply.kind === 'port.error') return { ok: false, code: reply.error, message: reply.message }
      return { ok: true, value: reply.value }
    },
  })
  return {
    ...drv,
    root,
    hello: () => drv.hello('question'),
    call: async (method, args, env = FIXED_ENV) => (await drv.call('question', method, args, env)).value,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  return extern?.payload ?? null
}

function question(id = 'q1', extra = {}) {
  return { id, header: '顶栏位置', question: '放哪里？', options: [{ label: '左' }, { label: '右' }], multiple: false, custom: true, ...extra }
}

// ── 握手 / 声明 ────────────────────────────────────────────────────────────

test('hello 回 manifest：能力类与方法声明与 plugin.json 一致（durable）', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'question')
    assert.deepEqual(manifest.implements, ['question'])
    assert.deepEqual(manifest.methods.question, ['describe', 'invoke', 'list', 'state', 'sweep'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'durable')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('plugin.json / schema / .worldignore 声明口径', () => {
  const plugin = JSON.parse(readFileSync(join(PKG_ROOT, 'plugin.json'), 'utf8'))
  assert.equal(plugin.identity, 'question')
  assert.deepEqual(plugin.implements, ['question'])
  assert.deepEqual(plugin.pins, { input: 'input' })
  assert.equal(plugin.state, 'durable')
  assert.deepEqual(plugin.exclusive, ['data'])
  assert.deepEqual(plugin.methods.question, ['describe', 'invoke', 'list', 'state', 'sweep'])
  const kinds = plugin.members.map((member) => member.kind).sort()
  assert.deepEqual(kinds, ['execute', 'schema', 'term'])
  assert.equal(plugin.commands.length, 2)
  const answerCmd = plugin.commands.find((command) => command.name === 'question.answer')
  assert.equal(answerCmd.entry, 'terms/question.answer.json')
  assert.equal(answerCmd.argsSchema, 'schema/question.answer.args.json')
  const stateCmd = plugin.commands.find((command) => command.name === 'question.state')
  assert.equal(stateCmd.entry, 'terms/question.state.json')
  assert.equal(stateCmd.readonly, true)

  const schema = JSON.parse(readFileSync(join(PKG_ROOT, 'schema', 'question.json'), 'utf8'))
  assert.equal(schema.periodic[0].method, 'sweep')
  assert.equal(schema.periodic[0].reads, undefined, '队列出世界，不再注入投影切片')

  const worldignore = readFileSync(join(PKG_ROOT, '.worldignore'), 'utf8')
  assert.match(worldignore, /^test\/$/m)
  assert.match(worldignore, /^tools\/$/m)

  // 入口 term：eff 自身 invoke，args = null（槽由服务经 input.read 取，不再传投影）
  const term = JSON.parse(readFileSync(join(PKG_ROOT, 'terms', 'question.answer.json'), 'utf8'))
  assert.deepEqual(term, ['eff', 'question', 'invoke', ['c', null]])
  const stateTerm = JSON.parse(readFileSync(join(PKG_ROOT, 'terms', 'question.state.json'), 'utf8'))
  assert.deepEqual(stateTerm, ['eff', 'question', 'state', ['c', null]])
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
    drv.cleanup()
  }
})

// ── invoke 入队 ─────────────────────────────────────────────────────────────

test('invoke(question)：入队写自有存储 + resume 游标 + pending 事件，无世界写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      session: 'c1',
      thread: 't1',
      cursor: { node_index: 4, call_id: 'c1' },
      run: 'run-1',
    })
    assert.equal(value.ok, true)
    assert.equal(value.result.ok, true)
    assert.equal(value.result.status, 'pending')
    assert.equal(value.result.id, 'q-run-1-0')
    assert.equal(value.result.count, 1)
    assert.equal(value.result.render.detail.kind, 'question')
    assert.equal(value.result.render.detail.id, 'q-run-1-0')
    assert.equal(value.result.render.detail.expired, false)
    assert.equal(value.result.render.detail.answers, null)
    // 工具不产世界写：结果里不得出现 $directives / add_gen。
    assert.equal(JSON.stringify(value.result).includes('$directives'), false)
    assert.equal(JSON.stringify(value.result).includes('add_gen'), false)

    const listed = await drv.call('list', {})
    const item = externOf(listed).items[0]
    assert.equal(item.id, 'q-run-1-0')
    assert.equal(item.session, 'c1')
    assert.equal(item.thread, 't1')
    assert.equal(item.answers, null)
    assert.equal(item.expired, false)
    assert.deepEqual(item.resume, { command: 'chat.resume', args: { cursor: { node_index: 4, call_id: 'c1' }, thread: 't1' } })
    assert.equal(item.expires_at, '2023-11-14T22:23:20.000Z')

    const pending = drv.events.find((event) => event.topic === 'question.pending')
    assert.ok(pending, '应发 question.pending')
    assert.equal(pending.payload.run, 'run-1')
    assert.equal(pending.payload.thread, 't1')
    assert.equal(pending.payload.id, 'q-run-1-0')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke(question)：同回合同节点重复入队幂等收敛（不重复计数）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const args = {
      tool: 'question',
      args: { questions: [question()] },
      thread: 't1',
      cursor: { node_index: 4, call_id: 'c1' },
      run: 'run-1',
    }
    const first = await drv.call('invoke', args)
    const second = await drv.call('invoke', args)
    assert.equal(second.result.id, first.result.id)
    assert.equal(second.result.count, 1)
    assert.equal(externOf(await drv.call('list', {})).count, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke(question)：session 取会话 id（切片 / session_id 直给），非 null', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      session: { body: { current: 'c-9', conversations: [] }, refs: {} },
      thread: 't1',
      cursor: 'cur-5',
      run: 'run-1',
    })
    assert.equal(externOf(await drv.call('list', {})).items[0].session, 'c-9')

    await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      session_id: 'c-7',
      thread: 't1',
      cursor: 'cur-6',
      run: 'run-1',
    })
    const items = externOf(await drv.call('list', {})).items
    assert.equal(items[1].session, 'c-7')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke(question)：多问题 / 多选 / 自定义输入都保留', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', {
      tool: 'question',
      args: {
        questions: [
          { id: 'q1', header: 'A', question: '选哪些？', options: [{ label: 'x' }, { label: 'y' }], multiple: true, custom: true },
          { id: 'q2', header: 'B', question: '补充说明？', options: [] },
        ],
      },
      thread: 't1',
      cursor: 'cur-3',
      run: 'run-1',
    })
    const questions = externOf(await drv.call('list', {})).items[0].questions
    assert.equal(questions.length, 2)
    assert.equal(questions[0].multiple, true)
    assert.equal(questions[0].custom, true)
    assert.deepEqual(questions[1].options, [])
    assert.equal(questions[1].multiple, false)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke(question)：越界 / 缺字段回结构化错误、不产写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const tooMany = await drv.call('invoke', {
      tool: 'question',
      args: { questions: Array.from({ length: 9 }, (_, index) => question(`q${index}`)) },
    })
    assert.equal(tooMany.ok, false)
    assert.equal(tooMany.error.code, 'too_many_questions')

    const noId = await drv.call('invoke', { tool: 'question', args: { questions: [{ question: 'Q?' }] } })
    assert.equal(noId.error.code, 'missing_question_id')

    const dup = await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question('q1'), question('q1')] },
    })
    assert.equal(dup.error.code, 'duplicate_question_id')

    const unknown = await drv.call('invoke', { tool: 'nope', args: {} })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_tool')

    assert.equal(externOf(await drv.call('list', {})).count, 0, '非法入队不落账')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── list ───────────────────────────────────────────────────────────────────

test('list：读队列，返回 oldest→newest，统计 answered/expired', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'c0', run: 'run-1' })
    await drv.call('invoke', { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'c1', run: 'run-1' })
    const value = await drv.call('list', {})
    const payload = externOf(value)
    assert.equal(payload.count, 2)
    assert.deepEqual(payload.items.map((item) => item.id), ['q-run-1-0', 'q-run-1-1'])
    assert.equal(payload.answered, 0)
    assert.equal(payload.expired, 0)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── state（只读对账） ──────────────────────────────────────────────────────

test('state：只回 {id, answered, answers, expired}，不含 questions / resume', async () => {
  const drv = startService({ onPortCall: answerPortCall })
  try {
    await drv.hello()
    await drv.call('invoke', {
      tool: 'question',
      args: { questions: [question()] },
      thread: 't1',
      cursor: { node_index: 4, call_id: 'c1' },
      run: 'run-1',
    })
    const before = externOf(await drv.call('state', {}))
    assert.equal(before.ok, true)
    assert.deepEqual(before.items, [{ id: 'q-run-1-0', answered: false, answers: null, expired: false }])
    assert.equal('questions' in before.items[0], false)
    assert.equal('resume' in before.items[0], false)

    await drv.call('invoke', null, { run: 'r2', thread: 't1', now: 1_700_000_000_000 })
    const after = externOf(await drv.call('state', {}))
    assert.equal(after.items[0].answered, true)
    assert.deepEqual(after.items[0].answers, [{ question_id: 'q1', selected: ['左'] }])
    assert.equal(after.items[0].expired, false)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── sweep ──────────────────────────────────────────────────────────────────

test('sweep：过期项标 expired（count 不变），未到期不动', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call(
      'invoke',
      { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'c0', run: 'run-1', at: new Date(PAST).toISOString() },
      { run: 'run-1', thread: 't1', now: PAST },
    )
    await drv.call(
      'invoke',
      { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'c1', run: 'run-1', at: new Date(PAST + 10_000_000).toISOString() },
      { run: 'run-1', thread: 't1', now: PAST + 10_000_000 },
    )
    const value = await drv.call('sweep', {}, { run: null, thread: null, now: PAST + 1_000_000 })
    assert.equal(externOf(value).expired, 1)
    const items = externOf(await drv.call('list', {})).items
    assert.equal(items[0].expired, true)
    assert.equal(items[1].expired, false)
    assert.equal(externOf(await drv.call('list', {})).count, 2)

    const none = await drv.call('sweep', {}, { run: null, thread: null, now: PAST - 1 })
    assert.equal(externOf(none).changed, false)
    assert.equal(directivesOf(none).some((item) => item.kind === 'write'), false)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── 作答命令路径 ───────────────────────────────────────────────────────────

function answerPortCall(message, reply) {
  if (message.method === 'read') {
    const slot = { kind: 'question.answer', id: 'q-run-1-0', answers: [{ question_id: 'q1', selected: ['左'] }] }
    reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { slots: { t1: slot }, thread: 't1', slot } })
    return
  }
  reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true, thread: 't1' } })
}

test('answer：反向调 input.read 取槽 → 写回答案 → input.clear → eval(chat.resume) + extern', async () => {
  const drv = startService({ onPortCall: answerPortCall })
  try {
    await drv.hello()
    await drv.call('invoke', { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: { node_index: 4, call_id: 'c1' }, run: 'run-1' })
    const value = await drv.call('invoke', null, { run: 'r2', thread: 't1', now: 1_700_000_000_000 })
    const directives = directivesOf(value)
    assert.deepEqual(directives.map((item) => item.kind), ['eval', 'extern'])
    assert.deepEqual(directives[0], {
      kind: 'eval',
      command: 'chat.resume',
      args: { cursor: { node_index: 4, call_id: 'c1' }, thread: 't1', payload: { answers: [{ question_id: 'q1', selected: ['左'] }] } },
      inject: { ids: ['ids'] },
    })
    assert.equal(externOf(value).status, 'answered')
    assert.equal(externOf(value).id, 'q-run-1-0')

    // 反向调用：input.read 取槽 + input.clear 清槽。
    assert.deepEqual(drv.portCalls.map((call) => `${call.port}.${call.method}`), ['input.read', 'input.clear'])
    // 答案已写回自有存储。
    const item = externOf(await drv.call('list', {})).items[0]
    assert.deepEqual(item.answers, [{ question_id: 'q1', selected: ['左'] }])
    assert.equal(externOf(await drv.call('list', {})).answered, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('answer：无槽 → no_slot；id 找不到 → not_found + 清槽', async () => {
  const drv = startService({
    onPortCall: (message, reply) => {
      if (message.method === 'read') {
        reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { slots: { t1: { kind: 'idle' } }, thread: 't1', slot: { kind: 'idle' } } })
        return
      }
      reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true, thread: 't1' } })
    },
  })
  try {
    await drv.hello()
    const noSlot = await drv.call('invoke', null, { run: 'r2', thread: 't1', now: 0 })
    assert.equal(externOf(noSlot).error.code, 'no_slot')
    assert.equal(directivesOf(noSlot).some((item) => item.kind === 'write'), false)
    assert.deepEqual(drv.portCalls.map((call) => call.method), ['read'], '无槽不调 clear')
  } finally {
    drv.close()
    drv.cleanup()
  }

  const drv2 = startService({
    onPortCall: (message, reply) => {
      if (message.method === 'read') {
        const slot = { kind: 'question.answer', id: 'q-missing', answers: [] }
        reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { slots: { t1: slot }, thread: 't1', slot } })
        return
      }
      reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true, thread: 't1' } })
    },
  })
  try {
    await drv2.hello()
    const missing = await drv2.call('invoke', null, { run: 'r2', thread: 't1', now: 0 })
    assert.equal(externOf(missing).error.code, 'not_found')
    assert.deepEqual(drv2.portCalls.map((call) => call.method), ['read', 'clear'], '找不到项也清槽')
  } finally {
    drv2.close()
    drv2.cleanup()
  }
})

// ── 作答守卫 ───────────────────────────────────────────────────────────────

test('answer：已答 / 过期 / 坏 answers / 无游标 均结构化拒且清槽', async () => {
  // 已答：第一次作答成功后，同一槽再次作答 → already_answered。
  const answered = startService({ onPortCall: answerPortCall })
  try {
    await answered.hello()
    await answered.call('invoke', { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'cur-1', run: 'run-1' })
    const first = await answered.call('invoke', null, { run: 'r2', thread: 't1', now: 0 })
    assert.equal(externOf(first).status, 'answered')
    const second = await answered.call('invoke', null, { run: 'r3', thread: 't1', now: 0 })
    assert.equal(externOf(second).error.code, 'already_answered')
    assert.equal(directivesOf(second).some((item) => item.kind === 'eval'), false)
  } finally {
    answered.close()
    answered.cleanup()
  }

  // 过期：入队到过去，sweep 标过期后作答 → expired。
  const expired = startService({ onPortCall: answerPortCall })
  try {
    await expired.hello()
    await expired.call(
      'invoke',
      { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'cur-1', run: 'run-1', at: new Date(PAST).toISOString() },
      { run: 'run-1', thread: 't1', now: PAST },
    )
    await expired.call('sweep', {}, { run: null, thread: null, now: PAST + 1_000_000 })
    const value = await expired.call('invoke', null, { run: 'r2', thread: 't1', now: PAST + 1_000_000 })
    assert.equal(externOf(value).error.code, 'expired')
  } finally {
    expired.close()
    expired.cleanup()
  }

  // 坏 answers：question_id 非字符串 → bad_answers。
  const bad = startService({
    onPortCall: (message, reply) => {
      if (message.method === 'read') {
        reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { slot: { kind: 'question.answer', id: 'q-run-1-0', answers: [{ question_id: 1 }] } } })
        return
      }
      reply({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true } })
    },
  })
  try {
    await bad.hello()
    await bad.call('invoke', { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'cur-1', run: 'run-1' })
    const value = await bad.call('invoke', null, { run: 'r2', thread: 't1', now: 0 })
    assert.equal(externOf(value).error.code, 'bad_answers')
  } finally {
    bad.close()
    bad.cleanup()
  }

  // 无游标：入队未带 cursor → item.resume=null，作答回 no_resume_cursor（不发 chat.resume）。
  const noCursor = startService({ onPortCall: answerPortCall })
  try {
    await noCursor.hello()
    await noCursor.call('invoke', { tool: 'question', args: { questions: [question()] }, thread: 't1', run: 'run-1' })
    const value = await noCursor.call('invoke', null, { run: 'r2', thread: 't1', now: 0 })
    assert.equal(externOf(value).error.code, 'no_resume_cursor')
    assert.equal(directivesOf(value).some((item) => item.kind === 'eval'), false)
  } finally {
    noCursor.close()
    noCursor.cleanup()
  }
})

test('invoke(question)：expires_at 以 at 为基准（bag.at 与 env.now 不同也一致）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const base = 1_600_000_000_000
    await drv.call(
      'invoke',
      { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: 'cur-1', run: 'run-1', at: new Date(base).toISOString() },
      { run: 'run-1', thread: 't1', now: base + 999_999 },
    )
    const item = externOf(await drv.call('list', {})).items[0]
    assert.equal(item.at, new Date(base).toISOString())
    assert.equal(item.expires_at, new Date(base + 600000).toISOString(), 'expires_at = at + expires_ms')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── 入口 term 真求值（预置 eff 回灌） ──────────────────────────────────────

test('入口 term：最小求值器求值 terms/question.answer.json 得作答续跑计划', async () => {
  const drv = startService({ onPortCall: answerPortCall })
  try {
    await drv.hello()
    await drv.call('invoke', { tool: 'question', args: { questions: [question()] }, thread: 't1', cursor: { node_index: 4, call_id: 'c1' }, run: 'run-1' })
    const expected = await drv.call('invoke', null, { run: 'r2', thread: 't1', now: 1_700_000_000_000 })
    const term = JSON.parse(readFileSync(join(PKG_ROOT, 'terms', 'question.answer.json'), 'utf8'))

    const effId = H({ run: 'run-1', i: 0, n: 0 })
    const env = {
      ctx: {},
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
    drv.cleanup()
  }
})

// ── 跨宿主重启续跑（持久化游标） ────────────────────────────────────────────

test('跨重启续跑：重启后从持久化游标仍可作答续跑', async () => {
  const root = mkdtempSync(join(tmpdir(), 'question-restart-'))
  const first = startService({ root })
  await first.hello()
  await first.call('invoke', {
    tool: 'question',
    args: { questions: [question()] },
    thread: 't1',
    cursor: { node_index: 4, call_id: 'c1' },
    run: 'run-1',
  })
  first.close()
  await first.exit

  const second = startService({ root, onPortCall: answerPortCall })
  try {
    await second.hello()
    const item = externOf(await second.call('list', {})).items[0]
    assert.equal(item.id, 'q-run-1-0', '重启后重放仍见原队列项')
    assert.deepEqual(item.resume, {
      command: 'chat.resume',
      args: { cursor: { node_index: 4, call_id: 'c1' }, thread: 't1' },
    }, '持久化游标跨重启可取回')

    const value = await second.call('invoke', null, { run: 'r2', thread: 't1', now: 1_700_000_000_000 })
    assert.equal(directivesOf(value)[0].command, 'chat.resume')
    assert.deepEqual(directivesOf(value)[0].args.cursor, { node_index: 4, call_id: 'c1' }, '重启后仍可据游标续跑')
  } finally {
    second.close()
    second.cleanup()
  }
})
