// 接缝契约：`plugin-admin` 与真实宿主的插件入世接缝。
// 插件只产写计划；宿主的 `validate_package` 给出 commit 哈希，内核 `commit` 决定计划能否落账。
// 两侧哈希口径必须逐字节一致，否则 write 恒被 validate_required 拒绝或计划被内核拒。
// 该断言跨插件与冻结层，故住根 tests/contract/，import 真实 packages/host 与 packages/kernel。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'
import { commit, EMPTY_HEAD, EMPTY_WORLD } from '../../packages/kernel/index.ts'
import { validatePackage } from '../../packages/host/validate-package.ts'
import { blobPointerOf, blobSha256 } from '../../packages/host/blobs.ts'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const PKG_ROOT = join(ROOT, 'plugins', 'plugin-admin')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const H1 = 'a'.repeat(64)

function candidate(identity = 'candidate', extra = {}) {
  return {
    'plugin.json': JSON.stringify({
      identity,
      schema: 'plugin.schema.json',
      implements: [],
      methods: {},
      pins: { host: 'host' },
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

/** 真实宿主侧处理器：validate_package / blob.put 用冻结层实现，其余用确定性假值。 */
function realHostHandler({ identities = [] } = {}) {
  return (port, method, args) => {
    if (method === 'identities') return { value: { list: identities } }
    if (method === 'source.read') {
      return { value: { path: args.path, content: Buffer.from('hi').toString('base64'), size: 2 } }
    }
    if (method === 'validate_package') {
      const runtime = mkdtempSync(join(tmpdir(), 'plugin-admin-contract-'))
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
  }
}

function startService(options = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'plugin-admin-contract-state-'))
  const handler = realHostHandler(options)
  const drv = startSdkService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    env: { CHRONO_PLUGIN_STATE: stateDir },
    onPortCall: (message) => {
      const outcome = handler(message.port, message.method, message.args)
      if (outcome.error) return { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
      return { ok: true, value: outcome.value }
    },
  })
  return {
    stateDir,
    hello: () => drv.hello('plugin-admin'),
    call: (port, method, args, env = FIXED_ENV) => drv.call(port, method, args, env).then((m) => m.value),
    callRaw: (port, method, args, env = FIXED_ENV) => drv.call(port, method, args, env),
    close: () => drv.close(),
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

function batchOps(value) {
  assert.ok(Array.isArray(value.$directives), 'plan must carry $directives')
  assert.equal(value.$directives[0].kind, 'write')
  assert.equal(value.$directives[0].request.op, 'batch')
  return value.$directives[0].request.args.ops
}

function commitBatch(ops) {
  return commit(
    EMPTY_HEAD,
    structuredClone(EMPTY_WORLD),
    { id: 'test-batch', op: 'batch', target: { expect_pos: null }, args: { ops }, by: 'test' },
    FIXED_ENV.now,
  )
}

test('接缝：真实 validate_package 的 result_hash 与插件 write 计划一致并被内核接受', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = candidate('candidate')
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.match(report.result_hash, /^[0-9a-f]{64}$/)

    const plan = await drv.call('plugin', 'write', { identity: 'candidate', files })
    const ops = batchOps(plan)
    const opKinds = ops.map((op) => op.op)
    assert.equal(opKinds[opKinds.length - 1], 'add_gen')
    assert.equal(opKinds[opKinds.length - 2], 'add_identity')
    assert.ok(opKinds.filter((kind) => kind === 'put').length >= 4)
    const addIdentity = ops[ops.length - 2]
    const addGen = ops[ops.length - 1]
    assert.equal(addIdentity.args.id, 'candidate')
    assert.deepEqual(addIdentity.args.schema, { $n: ops.length - 3 })
    assert.equal(addGen.args.id, 'candidate')
    assert.deepEqual(addGen.args.payload, { $n: ops.length - 4 })
    assert.deepEqual(addGen.args.sig, addGen.args.payload)
    assert.deepEqual(addGen.args.pins, { host: 'host' })
    assert.equal(plan.$directives[1].payload.new_identity, true)
    assert.equal(plan.$directives[1].payload.commit, report.result_hash)

    const outcome = commitBatch(ops)
    assert.equal(outcome.verdict.ok, true, JSON.stringify(outcome.verdict))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('接缝：身份已存在 → 无 add_identity，仅 add_gen（真实 validate 通过）', async () => {
  const drv = startService({ identities: [{ id: 'candidate', active: H1, implements: [], commands: [] }] })
  try {
    await drv.hello()
    const files = candidate('candidate')
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
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

test('接缝：零 schema 候选（省略 schema 字段）→ 真实 validate 通过、用宿主默认体、内核接受', async () => {
  const drv = startService()
  try {
    await drv.hello()
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

    const outcome = commitBatch(ops)
    assert.equal(outcome.verdict.ok, true, JSON.stringify(outcome.verdict))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('接缝：errors 路径（缺 plugin.json）真实宿主回 missing_plugin_json 且不写缓存', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = { 'plugin.schema.json': '{}' }
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0].code, 'missing_plugin_json')
    assert.equal(report.result_hash, null)
    const cacheFile = join(drv.stateDir, 'validate', `${report.candidate_hash}.json`)
    assert.equal(existsSync(cacheFile), false)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('接缝：invoke plugin.write 经真实宿主后计划可冒泡', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const files = candidate('candidate')
    await drv.call('plugin', 'validate', { identity: 'candidate', files })
    const written = await drv.call('plugin-admin', 'invoke', {
      tool: 'plugin.write',
      args: { identity: 'candidate', files },
    })
    assert.equal(written.ok, true, JSON.stringify(written))
    assert.equal(written.result.$directives[0].request.op, 'batch')
    // 缓存文件确实被 validate 写入（键 = 候选树哈希）。
    const report = await drv.call('plugin', 'validate', { identity: 'candidate', files })
    const cached = JSON.parse(
      readFileSync(join(drv.stateDir, 'validate', `${report.candidate_hash}.json`), 'utf8'),
    )
    assert.equal(cached.result_hash, report.result_hash)
  } finally {
    drv.close()
    drv.cleanup()
  }
})
