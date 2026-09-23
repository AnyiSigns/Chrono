// `plugin-admin` 服务协议级测试（node --test）：自实现最小协议驱动，并**扮演宿主侧**——
// 收到服务上行的 `port.call` 帧后按测试意图回 `port.result` / `port.error`（docs/protocol.md §2.4）。
// validate / write 的宿主应答复用**真实**的 host.validate_package（EMPTY_WORLD），使 result_hash
// 与 write 计划算出的 commit 哈希口径一致；再用真实内核 `commit` 验证写计划可被接受。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { commit, EMPTY_HEAD, EMPTY_WORLD } from '../../../packages/kernel/index.ts'
import { validatePackage } from '../../../packages/host/validate-package.ts'
import { blobPointerOf, blobSha256 } from '../../../packages/host/blobs.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

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

/** 候选包（扁平 + 一个 execute/ 子目录；pin host 以覆盖保留身份路径）。 */
function candidate(identity = 'candidate', extra = {}) {
  return {
    'plugin.json': JSON.stringify({
      identity,
      schema: 'plugin.schema.json',
      implements: [],
      methods: {},
      pins: { host: 'host' },
      start: '',
      protocol: '1',
      restart: { policy: 'never', backoff: 'none', max: 0, window_ms: 1, drain_ms: 1 },
      health: { probe: '', interval_ms: 0, timeout_ms: 0 },
      state: 'recomputable',
      members: [],
      commands: [],
      ...extra,
    }),
    'plugin.schema.json': JSON.stringify({ type: 'object' }),
    'package.json': JSON.stringify({ name: identity, version: '1.2.3' }),
    'execute/main.js': 'export const x = 1\n',
  }
}

/**
 * 启动服务并扮演宿主侧。`hostHandler(port, method, args)` 返回
 * `{ value }` 或 `{ error: code, message? }`；默认处理 identities / source.read / validate_package。
 */
function startService(options = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'plugin-admin-state-'))
  const calls = []
  const handler =
    options.hostHandler ??
    ((port, method, args) => {
      if (method === 'identities') {
        return {
          value: {
            list: [
              { id: 'toy-alpha', active: H1, implements: ['toy.alpha'], commands: [] },
              { id: 'sandbox', active: H2, implements: ['sandbox'], commands: [] },
              { id: 'plugin-admin', active: H1, implements: ['plugin', 'plugin-admin'], commands: [] },
            ],
          },
        }
      }
      if (method === 'source.read') {
        return { value: { path: args.path, content: Buffer.from('hi').toString('base64'), size: 2 } }
      }
      if (method === 'validate_package') {
        const runtime = mkdtempSync(join(tmpdir(), 'plugin-admin-validate-'))
        try {
          const outcome = validatePackage(EMPTY_WORLD, runtime, args.files)
          return outcome.accepted
            ? { value: outcome.report }
            : { error: 'bad_directive', message: outcome.message }
        } finally {
          rmSync(runtime, { recursive: true, force: true })
        }
      }
      if (method === 'blob.put') {
        const bytes = Buffer.from(args.bytes, 'base64')
        return { value: blobPointerOf(blobSha256(bytes), bytes.length) }
      }
      return { error: 'not_loaded', message: method }
    })

  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHRONO_PLUGIN_STATE: stateDir },
  })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        calls.push({ port: message.port, method: message.method, args: message.args })
        const outcome = handler(message.port, message.method, message.args)
        const frame = outcome.error
          ? {
              v: '1',
              id: message.id,
              kind: 'port.error',
              ok: false,
              error: outcome.error,
              message: outcome.message ?? outcome.error,
            }
          : { v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome.value }
        child.stdin.write(encodeFrame(frame))
        continue
      }
      const handlerForId = pending.get(message.id)
      if (handlerForId !== undefined) {
        pending.delete(message.id)
        handlerForId(message)
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
    stateDir,
    calls,
    events,
    exit,
    request,
    async hello() {
      return request('hello', { impl: 'plugin-admin', gen: 'gen-1' }, 'manifest')
    },
    async call(port, method, args, env = FIXED_ENV) {
      const message = await request('call', { port, method, args, env }, 'result')
      return message.value
    },
    async callRaw(port, method, args, env = FIXED_ENV) {
      return request('call', { port, method, args, env }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
    cleanup() {
      try {
        child.kill()
      } catch {
        // 已退出
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

function batchOps(value) {
  assert.ok(Array.isArray(value.$directives), 'plan must carry $directives')
  assert.equal(value.$directives[0].kind, 'write')
  assert.equal(value.$directives[0].request.op, 'batch')
  return value.$directives[0].request.args.ops
}

function cacheFile(stateDir, key) {
  return join(stateDir, 'validate', `${key}.json`)
}

// ── 握手 / 控制 / 自退出 ────────────────────────────────────────────────────

test('hello 回 manifest：双能力类与方法声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'plugin-admin')
    assert.deepEqual(manifest.implements, ['plugin', 'plugin-admin'])
    assert.deepEqual(manifest.methods.plugin, ['list', 'read', 'validate', 'write'])
    assert.deepEqual(manifest.methods['plugin-admin'], ['describe', 'invoke'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('reload → ack / probe → pong / drain → bye', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('stdin EOF 即自退出（断连不占端点）', async () => {
  const drv = startService()
  await drv.hello()
  drv.close()
  const code = await drv.exit
  drv.cleanup()
  assert.equal(code, 0)
})

// ── list ───────────────────────────────────────────────────────────────────

test('list：host.identities 返回后过滤 sandbox 与自身', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('plugin', 'list', {})
    const ids = value.list.map((item) => item.id)
    assert.deepEqual(ids, ['toy-alpha'])
    assert.equal(drv.calls[0].method, 'identities')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('可见性黑名单不被世界数据 / bag 改写（只住包内常量）', async () => {
  const drv = startService({
    hostHandler: (port, method) => {
      if (method === 'identities') {
        return {
          value: {
            list: [
              { id: 'sandbox', active: H1, implements: [], commands: [] },
              { id: 'plugin-admin', active: H1, implements: [], commands: [] },
              { id: 'visible-one', active: H1, implements: [], commands: [] },
            ],
          },
        }
      }
      return { error: 'not_loaded', message: method }
    },
  })
  try {
    await drv.hello()
    const value = await drv.call('plugin', 'list', {
      visibility: { hidden: [], allow: ['sandbox', 'plugin-admin'] },
      hidden: [],
      body: { visibility_blacklist: [] },
    })
    assert.deepEqual(value.list.map((item) => item.id), ['visible-one'])
  } finally {
    drv.close()
    drv.cleanup()
  }

  // 静态断言：名单只在包内常量文件；schema 与 plugin.json（世界数据面）不含它。
  const visibility = readFileSync(join(PKG_ROOT, 'execute', 'visibility.ts'), 'utf8')
  assert.match(visibility, /'sandbox'/)
  assert.match(visibility, /'plugin-admin'/)
  const schema = readFileSync(join(PKG_ROOT, 'schema', 'plugin-admin.json'), 'utf8')
  const plugin = readFileSync(join(PKG_ROOT, 'plugin.json'), 'utf8')
  assert.equal(schema.includes('sandbox'), false)
  assert.equal(plugin.includes('sandbox'), false)
})

// ── read ───────────────────────────────────────────────────────────────────

test('read：正常透传 host.source.read', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('plugin', 'read', { identity: 'toy-alpha', path: 'plugin.json' })
    assert.equal(value.path, 'plugin.json')
    assert.equal(Buffer.from(value.content, 'base64').toString('utf8'), 'hi')
    assert.equal(drv.calls[0].method, 'source.read')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('read：黑名单身份 → hidden_identity，且不调宿主', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const hidden = await drv.callRaw('plugin', 'read', { identity: 'sandbox', path: 'plugin.json' })
    assert.equal(hidden.kind, 'error')
    assert.equal(hidden.code, 'hidden_identity')
    const self = await drv.callRaw('plugin', 'read', {
      identity: 'plugin-admin',
      path: 'execute/main.ts',
    })
    assert.equal(self.code, 'hidden_identity')
    assert.equal(drv.calls.length, 0, '黑名单读不得触达宿主')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('read：宿主错误透传（not_found）', async () => {
  const drv = startService({
    hostHandler: (port, method) => {
      if (method === 'source.read') return { error: 'not_found', message: 'missing' }
      return { error: 'not_loaded', message: method }
    },
  })
  try {
    await drv.hello()
    const missing = await drv.callRaw('plugin', 'read', { identity: 'toy-alpha', path: 'nope' })
    assert.equal(missing.kind, 'error')
    assert.equal(missing.code, 'not_found')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── validate ───────────────────────────────────────────────────────────────

test('validate：ok 路径回 result_hash 并写入 ③ 缓存', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = candidate('candidate')
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, true)
    assert.deepEqual(report.errors, [])
    assert.match(report.result_hash, /^[0-9a-f]{64}$/)
    assert.match(report.candidate_hash, /^[0-9a-f]{64}$/)
    const cached = JSON.parse(readFileSync(cacheFile(drv.stateDir, report.candidate_hash), 'utf8'))
    assert.equal(cached.result_hash, report.result_hash)
    assert.equal(cached.identity, 'candidate')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('validate：errors 路径（缺 plugin.json）回 ok:false 且不写缓存', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = { 'plugin.schema.json': '{}' }
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0].code, 'missing_plugin_json')
    assert.equal(report.result_hash, null)
    assert.equal(existsSync(cacheFile(drv.stateDir, report.candidate_hash)), false)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── write ──────────────────────────────────────────────────────────────────

test('write：身份不存在 → add_identity + put 链 + add_gen 占位符序；内核接受', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = candidate('candidate')
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    const plan = await drv.call('plugin', 'write', { identity: 'candidate', files })
    const ops = batchOps(plan)

    // 结构：put(blob/…)+put(tree)+put(commit)+put(schema)+add_identity+add_gen
    const opKinds = ops.map((op) => op.op)
    assert.equal(opKinds[opKinds.length - 1], 'add_gen')
    assert.equal(opKinds[opKinds.length - 2], 'add_identity')
    assert.ok(opKinds.filter((kind) => kind === 'put').length >= 4)
    const addIdentity = ops[ops.length - 2]
    const addGen = ops[ops.length - 1]
    assert.equal(addIdentity.args.id, 'candidate')
    assert.deepEqual(addIdentity.args.schema, { $n: ops.length - 3 }) // put(schema)
    assert.equal(addGen.args.id, 'candidate')
    assert.deepEqual(addGen.args.payload, { $n: ops.length - 4 }) // put(commit)
    assert.deepEqual(addGen.args.sig, addGen.args.payload)
    assert.deepEqual(addGen.args.pins, { host: 'host' })

    // commit def 的 tree 占位指向根 tree；根 tree 的 entries 用 $n 指 blob。
    const commitOp = ops[ops.length - 4]
    assert.equal(typeof commitOp.args.body.tree.$n, 'number')
    assert.equal(commitOp.args.body.meta.name, 'candidate')
    assert.equal(commitOp.args.body.meta.version, '1.2.3')
    const rootTree = ops[commitOp.args.body.tree.$n]
    assert.ok(Array.isArray(rootTree.args.body.entries))
    assert.ok(rootTree.args.body.entries.some((entry) => entry.hash && entry.hash.$n !== undefined))

    // extern 摘要
    assert.equal(plan.$directives[1].kind, 'extern')
    assert.equal(plan.$directives[1].payload.new_identity, true)
    assert.equal(plan.$directives[1].payload.commit, report.result_hash)

    // 真实内核接受该 batch（空世界 + 空链头）
    const outcome = commit(
      EMPTY_HEAD,
      structuredClone(EMPTY_WORLD),
      { id: 'test-batch', op: 'batch', target: { expect_pos: null }, args: { ops }, by: 'test' },
      FIXED_ENV.now,
    )
    assert.equal(outcome.verdict.ok, true, JSON.stringify(outcome.verdict))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：身份已存在 → 无 add_identity（只 add_gen）', async () => {
  const drv = startService({
    hostHandler: (port, method, args) => {
      if (method === 'identities') {
        return { value: { list: [{ id: 'candidate', active: H1, implements: [], commands: [] }] } }
      }
      if (method === 'validate_package') {
        const runtime = mkdtempSync(join(tmpdir(), 'plugin-admin-validate-'))
        try {
          const outcome = validatePackage(EMPTY_WORLD, runtime, args.files)
          return outcome.accepted
            ? { value: outcome.report }
            : { error: 'bad_directive', message: outcome.message }
        } finally {
          rmSync(runtime, { recursive: true, force: true })
        }
      }
      if (method === 'blob.put') {
        const bytes = Buffer.from(args.bytes, 'base64')
        return { value: blobPointerOf(blobSha256(bytes), bytes.length) }
      }
      return { error: 'not_loaded', message: method }
    },
  })
  try {
    await drv.hello()
    const files = candidate('candidate')
    await drv.call('plugin', 'validate', { identity: 'candidate', files })
    const plan = await drv.call('plugin', 'write', { identity: 'candidate', files })
    const ops = batchOps(plan)
    assert.equal(ops.filter((op) => op.op === 'add_identity').length, 0)
    assert.equal(ops[ops.length - 1].op, 'add_gen')
    assert.equal(plan.$directives[1].payload.new_identity, false)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：零 schema 候选（省略 schema 字段）→ validate 通过、write 成功用宿主默认体', async () => {
  const drv = startService()
  try {
    await drv.hello()
    // 候选 plugin.json 省略 `schema`，且不带 schema 文件——与宿主「零 schema」同口径
    const files = candidate('candidate')
    const decl = JSON.parse(files['plugin.json'])
    delete decl.schema
    files['plugin.json'] = JSON.stringify(decl)
    delete files['plugin.schema.json']

    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.match(report.result_hash, /^[0-9a-f]{64}$/)

    const plan = await drv.call('plugin', 'write', { identity: 'candidate', files })
    const ops = batchOps(plan)
    const addIdentity = ops[ops.length - 2]
    assert.equal(addIdentity.op, 'add_identity')
    const schemaOp = ops[addIdentity.args.schema.$n]
    assert.deepEqual(schemaOp.args.body, { type: 'object' })

    const outcome = commit(
      EMPTY_HEAD,
      structuredClone(EMPTY_WORLD),
      { id: 'test-batch-zero', op: 'batch', target: { expect_pos: null }, args: { ops }, by: 'test' },
      FIXED_ENV.now,
    )
    assert.equal(outcome.verdict.ok, true, JSON.stringify(outcome.verdict))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：缺 validate 凭据 → validate_required（且不调宿主 identities）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const rejected = await drv.callRaw('plugin', 'write', {
      identity: 'candidate',
      files: candidate('candidate'),
    })
    assert.equal(rejected.kind, 'error')
    assert.equal(rejected.code, 'validate_required')
    assert.equal(drv.calls.length, 0)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：候选树哈希不符（凭据被篡改）→ validate_required 并清凭据', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = candidate('candidate')
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    const file = cacheFile(drv.stateDir, report.candidate_hash)
    writeFileSync(file, JSON.stringify({ identity: 'candidate', result_hash: '0'.repeat(64), at: 0 }))
    const rejected = await drv.callRaw('plugin', 'write', { identity: 'candidate', files })
    assert.equal(rejected.kind, 'error')
    assert.equal(rejected.code, 'validate_required')
    assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：带回的 result_hash 与 ③ 凭据不符 → validate_required', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = candidate('candidate')
    await drv.call('plugin', 'validate', { identity: 'candidate', files })
    const rejected = await drv.callRaw('plugin', 'write', {
      identity: 'candidate',
      files,
      result_hash: 'f'.repeat(64),
    })
    assert.equal(rejected.kind, 'error')
    assert.equal(rejected.code, 'validate_required')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：黑名单身份 → hidden_identity，不调宿主', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const rejected = await drv.callRaw('plugin', 'write', {
      identity: 'sandbox',
      files: candidate('sandbox'),
    })
    assert.equal(rejected.code, 'hidden_identity')
    assert.equal(drv.calls.length, 0)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── describe / invoke ──────────────────────────────────────────────────────

test('describe：四工具 + render 描述符 + 描述四要素', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('plugin-admin', 'describe', {})
    const tools = value.tools
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['plugin.list', 'plugin.read', 'plugin.validate', 'plugin.write'],
    )
    for (const tool of tools) {
      for (const field of ['intent', 'when_to_use', 'param_semantics', 'boundaries']) {
        assert.ok(tool[field] !== undefined, `${tool.name} missing ${field}`)
      }
      assert.equal(tool.render.form, 'card')
      assert.equal(tool.render.label, 'plugin')
      assert.equal(tool.render.tone, 'solid')
      assert.ok(['list', 'code', 'json', 'diff'].includes(tool.render.detail.kind))
      // param_semantics 覆盖 argsSchema.required
      for (const key of tool.argsSchema.required ?? []) {
        assert.ok(tool.param_semantics[key] !== undefined, `${tool.name} param ${key}`)
      }
    }
    assert.equal(tools.find((tool) => tool.name === 'plugin.write').idempotent, false)
    assert.equal(tools.find((tool) => tool.name === 'plugin.write').render.detail.kind, 'diff')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke：按工具名派发；未知工具回 unknown_tool；write 计划可冒泡', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const listed = await drv.call('plugin-admin', 'invoke', { tool: 'plugin.list', args: {} })
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.result.list.map((item) => item.id), ['toy-alpha'])

    const unknown = await drv.call('plugin-admin', 'invoke', { tool: 'plugin.nope', args: {} })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_tool')

    const files = candidate('candidate')
    await drv.call('plugin', 'validate', { identity: 'candidate', files })
    const written = await drv.call('plugin-admin', 'invoke', {
      tool: 'plugin.write',
      args: { identity: 'candidate', files },
    })
    assert.equal(written.ok, true)
    assert.equal(written.result.$directives[0].request.op, 'batch')

    const hidden = await drv.call('plugin-admin', 'invoke', {
      tool: 'plugin.read',
      args: { identity: 'sandbox', path: 'plugin.json' },
    })
    assert.equal(hidden.ok, false)
    assert.equal(hidden.error.code, 'hidden_identity')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── 结构化错误 ─────────────────────────────────────────────────────────────

test('未知能力 / 方法 / 非对象 args → 结构化错误，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const badPort = await drv.callRaw('nope', 'list', {})
    assert.equal(badPort.code, 'unresolved_cap')
    const badMethod = await drv.callRaw('plugin', 'nope', {})
    assert.equal(badMethod.code, 'unknown_method')
    const badArgs = await drv.callRaw('plugin', 'read', 'not-an-object')
    assert.equal(badArgs.code, 'bad_args')
    // 进程仍可服务
    const ok = await drv.call('plugin', 'list', {})
    assert.equal(ok.list.length, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})
