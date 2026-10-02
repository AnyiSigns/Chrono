// `plugin` 管理平面服务协议级测试（node --test）：自实现最小协议驱动，并扮演宿主侧回 `port.call`。
// 本文件只覆盖插件自身逻辑：方法派发、可见性过滤、validate 凭据缓存、write 的前置拒绝、
// 结构化错误。与真实宿主的接缝（validate_package 的 result_hash、write 计划被内核接受）
// 属跨层断言，住根 `tests/contract/`，由那里 import 真实的 packages/kernel 与 packages/host。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'
import { readValidateCache, writeValidateCache } from '../execute/state.ts'
import { buildPackOps, parseCandidateDecl } from '../execute/pack.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
/** 假宿主返回的确定性 result_hash：插件只关心它是 64 位十六进制并落 ③ 缓存。 */
const STUB_RESULT_HASH = 'a'.repeat(64)

/** 候选包（扁平 + 一个 execute/ 子目录；host 以 needs 哨兵覆盖保留身份路径）。 */
function candidate(identity = 'candidate', extra = {}) {
  return {
    'plugin.json': JSON.stringify({
      identity,
      schema: 'plugin.schema.json',
      implements: [],
      methods: {},
      needs: { host: { mode: 'one' } },
      start: '',
      build: [],
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

/** 默认假宿主：identities / source.read / validate_package / blob.put 的确定性应答。 */
function stubHostHandler(port, method, args) {
  if (method === 'identities') {
    return {
      value: {
        list: [
          { id: 'toy-alpha', active: H1, implements: ['toy.alpha'], commands: [] },
          { id: 'sandbox', active: H2, implements: ['sandbox'], commands: [] },
          { id: 'plugin', active: H1, implements: ['plugin'], commands: [] },
          { id: 'plugin-admin', active: H1, implements: ['plugin-admin'], commands: [] },
        ],
      },
    }
  }
  if (method === 'source.read') {
    return { value: { path: args.path, content: Buffer.from('hi').toString('base64'), size: 2 } }
  }
  if (method === 'validate_package') {
    const files = args.files ?? {}
    if (files['plugin.json'] === undefined) {
      return {
        value: {
          ok: false,
          errors: [{ code: 'missing_plugin_json', path: '', message: 'missing plugin.json' }],
          result_hash: null,
        },
      }
    }
    return { value: { ok: true, errors: [], result_hash: STUB_RESULT_HASH } }
  }
  if (method === 'blob.put') {
    return { value: { kind: 'blob', sha256: '0'.repeat(64), size: 2 } }
  }
  return { error: 'not_loaded', message: method }
}

/** 用插件自身的打包口径算出候选 commit 哈希，作为假宿主 validate_package 的 result_hash。 */
function commitHashOf(files, needs) {
  const decl = parseCandidateDecl(files)
  return buildPackOps(files, decl.identity, decl, needs).commitHash
}

/**
 * 假宿主工厂：identities 可定制；validate_package 回执的 `result_hash` 按同一 needs 现算，
 * 以模拟宿主「解析结果进 commit 哈希」的口径。
 */
function stubHostResolving({ needs = {}, identities = [] } = {}) {
  return (port, method, args) => {
    if (method === 'identities') return { value: { list: identities } }
    if (method === 'validate_package') {
      return {
        value: { ok: true, errors: [], result_hash: commitHashOf(args.files, needs), needs },
      }
    }
    if (method === 'blob.put') {
      return { value: { kind: 'blob', sha256: '0'.repeat(64), size: 2 } }
    }
    return { error: 'not_loaded', message: method }
  }
}

/**
 * 启动服务并扮演宿主侧。`hostHandler(port, method, args)` 返回
 * `{ value }` 或 `{ error: code, message? }`；默认用确定性假宿主。
 */
function startService(options = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'plugin-state-'))
  const calls = []
  const handler = options.hostHandler ?? stubHostHandler

  const drv = startSdkService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    env: { CHRONO_PLUGIN_STATE: stateDir },
    onPortCall: (message) => {
      calls.push({ port: message.port, method: message.method, args: message.args })
      const outcome = handler(message.port, message.method, message.args)
      if (outcome.error)
        return { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
      return { ok: true, value: outcome.value }
    },
  })

  return {
    child: drv.child,
    stateDir,
    calls,
    events: drv.events,
    exit: drv.exit,
    request: drv.request,
    hello: () => drv.hello('plugin'),
    async call(port, method, args, env = FIXED_ENV) {
      const message = await drv.call(port, method, args, env)
      return message.value
    },
    callRaw: (port, method, args, env = FIXED_ENV) => drv.call(port, method, args, env),
    close() {
      drv.close()
    },
    cleanup() {
      try {
        drv.child.kill()
      } catch {
        // 已退出
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

function cacheFile(stateDir, key) {
  return join(stateDir, 'validate', `${key}.json`)
}

// ── 握手 / 控制 / 自退出 ────────────────────────────────────────────────────

test('hello 回 manifest：能力类与方法声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'plugin')
    assert.deepEqual(manifest.implements, ['plugin'])
    assert.deepEqual(manifest.methods.plugin, ['list', 'read', 'validate', 'write'])
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

test('list：host.identities 返回后过滤 sandbox、plugin 与 plugin-admin', async () => {
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
              { id: 'plugin', active: H1, implements: [], commands: [] },
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
      visibility: { hidden: [], allow: ['sandbox', 'plugin', 'plugin-admin'] },
      hidden: [],
      body: { visibility_blacklist: [] },
    })
    assert.deepEqual(
      value.list.map((item) => item.id),
      ['visible-one'],
    )
  } finally {
    drv.close()
    drv.cleanup()
  }

  // 静态断言：名单只在包内常量文件；schema 与 plugin.json（世界数据面）不含它。
  const visibility = readFileSync(join(PKG_ROOT, 'execute', 'visibility.ts'), 'utf8')
  assert.match(visibility, /'sandbox'/)
  assert.match(visibility, /'plugin'/)
  assert.match(visibility, /'plugin-admin'/)
  const schema = readFileSync(join(PKG_ROOT, 'schema', 'plugin.json'), 'utf8')
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
      identity: 'plugin',
      path: 'execute/main.ts',
    })
    assert.equal(self.code, 'hidden_identity')
    const admin = await drv.callRaw('plugin', 'read', {
      identity: 'plugin-admin',
      path: 'execute/main.ts',
    })
    assert.equal(admin.code, 'hidden_identity')
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

// ── validate（凭据缓存；宿主 result_hash 口径的接缝断言住 tests/contract/） ────

test('validate：宿主 ok 回执透传并写入 ③ 缓存', async () => {
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
    assert.deepEqual(cached.needs, {})
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('validate：errors 路径回 ok:false 且不写缓存', async () => {
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

// ── write：前置拒绝与凭据比对 ────────────────────────────────────────────────

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
    writeFileSync(
      file,
      JSON.stringify({ identity: 'candidate', result_hash: '0'.repeat(64), at: 0 }),
    )
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

test('write：one-needs 绑定以身份名写入 commit.body.meta.needs（非 active 哈希）', async () => {
  const files = candidate('candidate', {
    needs: { host: { mode: 'one' }, model: { mode: 'one' } },
  })
  const identities = [
    { id: 'candidate', active: H1, implements: [], commands: [] },
    { id: 'model-protocol', active: H2, implements: ['model'], commands: [] },
  ]
  const bindings = { host: 'host', model: 'model-protocol' }
  const drv = startService({ hostHandler: stubHostResolving({ needs: bindings, identities }) })
  try {
    await drv.hello()
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, true)
    const plan = await drv.call('plugin', 'write', { identity: 'candidate', files })
    const ops = plan.$directives[0].request.args.ops
    const addGen = ops[ops.length - 1]
    assert.equal(addGen.op, 'add_gen')
    assert.ok(!('pins' in addGen.args), 'add_gen 不再带 pins')
    const commitOp = ops.find(
      (op) => op.op === 'put' && op.args.body && op.args.body.meta && op.args.body.meta.needs,
    )
    assert.deepEqual(commitOp.args.body.meta.needs, bindings)
    assert.equal(commitOp.args.body.meta.needs.model, 'model-protocol')
    assert.notEqual(commitOp.args.body.meta.needs.model, H2, '绑定不得写成 active 哈希')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：auto_validate 单调用自动先校验并产计划', async () => {
  const drv = startService({ hostHandler: stubHostResolving() })
  try {
    await drv.hello()
    const files = candidate('candidate')
    const plan = await drv.call('plugin', 'write', {
      identity: 'candidate',
      files,
      auto_validate: true,
    })
    const payload = plan.$directives[1].payload
    assert.equal(payload.ok, true, JSON.stringify(plan))
    assert.equal(payload.identity, 'candidate')
    const methods = drv.calls.map((call) => call.method)
    assert.equal(methods.filter((method) => method === 'validate_package').length, 1)
    assert.ok(methods.includes('identities'))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：auto_validate 校验失败 → validate_failed（不产计划）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const rejected = await drv.callRaw('plugin', 'write', {
      identity: 'candidate',
      files: { 'plugin.schema.json': '{}' },
      auto_validate: true,
    })
    assert.equal(rejected.kind, 'error')
    assert.equal(rejected.code, 'validate_failed')
    assert.equal(drv.calls.filter((call) => call.method === 'identities').length, 0)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('write：one need 的解析结果进 meta.needs 与 commit 哈希（与 validate result_hash 一致）', async () => {
  const files = candidate('candidate', { needs: { model: { mode: 'one' } } })
  const needs = { model: 'model-protocol' }
  const identities = [
    { id: 'candidate', active: H1, implements: [], commands: [] },
    { id: 'model-protocol', active: H2, implements: ['model'], commands: [] },
  ]
  const drv = startService({ hostHandler: stubHostResolving({ needs, identities }) })
  try {
    await drv.hello()
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, true)
    assert.equal(report.result_hash, commitHashOf(files, needs))
    // 凭据须携带宿主解析结果，否则 write 算出的 commit 哈希对不上
    const cached = JSON.parse(readFileSync(cacheFile(drv.stateDir, report.candidate_hash), 'utf8'))
    assert.deepEqual(cached.needs, needs)

    const plan = await drv.call('plugin', 'write', { identity: 'candidate', files })
    assert.equal(plan.$directives[1].payload.commit, report.result_hash)
    const ops = plan.$directives[0].request.args.ops
    const commitOp = ops.find((op) => op.op === 'put' && op.args.body && op.args.body.meta)
    assert.deepEqual(commitOp.args.body.meta, { name: 'candidate', version: '1.2.3', needs })
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

// ── ③ 凭据缓存原子写 ────────────────────────────────────────────────────────

test('validate 凭据原子写：不留临时文件，内容可读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-state-atomic-'))
  const previous = process.env.CHRONO_PLUGIN_STATE
  process.env.CHRONO_PLUGIN_STATE = dir
  try {
    const key = 'a'.repeat(64)
    writeValidateCache(key, {
      identity: 'candidate',
      result_hash: 'b'.repeat(64),
      at: 123,
      needs: {},
    })
    // 临时文件已被 rename 消耗：目录里只剩最终文件
    assert.deepEqual(readdirSync(join(dir, 'validate')), [`${key}.json`])
    const entry = readValidateCache(key)
    assert.equal(entry.identity, 'candidate')
    assert.equal(entry.result_hash, 'b'.repeat(64))
    assert.deepEqual(entry.needs, {})
  } finally {
    if (previous === undefined) delete process.env.CHRONO_PLUGIN_STATE
    else process.env.CHRONO_PLUGIN_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readValidateCache：旧凭据缺 needs 字段 → 按空绑定读回（向前兼容）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-state-old-'))
  const previous = process.env.CHRONO_PLUGIN_STATE
  process.env.CHRONO_PLUGIN_STATE = dir
  try {
    const key = 'c'.repeat(64)
    mkdirSync(join(dir, 'validate'), { recursive: true })
    writeFileSync(
      join(dir, 'validate', `${key}.json`),
      JSON.stringify({ identity: 'candidate', result_hash: 'd'.repeat(64), at: 1 }),
    )
    const entry = readValidateCache(key)
    assert.equal(entry.result_hash, 'd'.repeat(64))
    assert.deepEqual(entry.needs, {})
  } finally {
    if (previous === undefined) delete process.env.CHRONO_PLUGIN_STATE
    else process.env.CHRONO_PLUGIN_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 包声明：管理平面用 host 保留能力类作为 needs 宿主哨兵 ─────────────────

test('plugin.json：needs.host=one（host 是保留能力类，作为宿主依赖哨兵）', () => {
  const decl = JSON.parse(readFileSync(join(PKG_ROOT, 'plugin.json'), 'utf8'))
  assert.deepEqual(decl.implements, ['plugin'])
  assert.deepEqual(decl.methods, { plugin: ['list', 'read', 'validate', 'write'] })
  assert.ok(!('pins' in decl), 'pins 字段已删除')
  assert.deepEqual(decl.needs, { host: { mode: 'one' } })
})
