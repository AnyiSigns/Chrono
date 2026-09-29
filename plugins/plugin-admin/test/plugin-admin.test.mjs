// `plugin-admin` 工具面服务协议级测试（node --test）：自实现最小协议驱动，并扮演宿主侧回反向 `port.call`。
// 覆盖：manifest 声明、describe 工具清单与四要素、invoke 按工具名派发到管理平面 `plugin`、
// 结构化错误（unknown_tool / bad_args / 管理平面错误透传）与控制帧。validate→write 重逻辑住 `plugin`，
// 由那里的 `node --test` 覆盖；本文件只验证工具面的薄适配接缝。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const PLAN_RESULT = { $directives: [{ kind: 'extern', payload: { ok: true } }] }

/** 默认假管理平面：按方法名回确定性值。 */
function stubPlaneHandler(port, method, args) {
  if (port !== 'plugin') return { error: 'unresolved_cap', message: port }
  switch (method) {
    case 'list':
      return { value: { list: [{ id: 'toy-alpha' }] } }
    case 'read':
      return { value: { path: args.path, content: Buffer.from('hi').toString('base64'), size: 2 } }
    case 'validate':
      return {
        value: {
          ok: true,
          errors: [],
          result_hash: 'a'.repeat(64),
          candidate_hash: 'b'.repeat(64),
        },
      }
    case 'write':
      return { value: PLAN_RESULT }
    default:
      return { error: 'unknown_method', message: method }
  }
}

/**
 * 启动服务并扮演宿主侧。`planeHandler(port, method, args)` 返回
 * `{ value }` 或 `{ error: code, message? }`；默认用确定性假管理平面。
 */
function startService(options = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'plugin-admin-state-'))
  const calls = []
  const handler = options.planeHandler ?? stubPlaneHandler

  const drv = startSdkService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    env: { CHRONO_PLUGIN_STATE: stateDir },
    onPortCall: (message) => {
      calls.push({ port: message.port, method: message.method, args: message.args })
      const outcome = handler(message.port, message.method, message.args)
      if (outcome.error) {
        return { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
      }
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
    hello: () => drv.hello('plugin-admin'),
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

// ── 握手 / 控制 / 自退出 ────────────────────────────────────────────────────

test('hello 回 manifest：只实现 plugin-admin，方法声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'plugin-admin')
    assert.deepEqual(manifest.implements, ['plugin-admin', 'tool-provider'])
    assert.deepEqual(manifest.methods['plugin-admin'], ['describe', 'invoke'])
    assert.deepEqual(manifest.methods['tool-provider'], ['describe', 'invoke'])
    assert.equal(manifest.methods.plugin, undefined, '管理平面能力类不再住本插件')
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

// ── describe ───────────────────────────────────────────────────────────────

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
    assert.equal(drv.calls.length, 0, 'describe 不应触达管理平面')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── invoke：按工具名派发到管理平面 ──────────────────────────────────────────

test('invoke：plugin.list / read / validate / write 各派发到同名管理平面方法', async () => {
  const drv = startService()
  try {
    await drv.hello()

    const listed = await drv.call('plugin-admin', 'invoke', { tool: 'plugin.list', args: {} })
    assert.equal(listed.ok, true)
    assert.deepEqual(
      listed.result.list.map((item) => item.id),
      ['toy-alpha'],
    )

    const read = await drv.call('plugin-admin', 'invoke', {
      tool: 'plugin.read',
      args: { identity: 'toy-alpha', path: 'plugin.json' },
    })
    assert.equal(read.ok, true)
    assert.equal(Buffer.from(read.result.content, 'base64').toString('utf8'), 'hi')

    const validated = await drv.call('plugin-admin', 'invoke', {
      tool: 'plugin.validate',
      args: { identity: 'candidate', files: {} },
    })
    assert.equal(validated.ok, true)
    assert.equal(validated.result.ok, true)

    const written = await drv.call('plugin-admin', 'invoke', {
      tool: 'plugin.write',
      args: { identity: 'candidate', files: {} },
    })
    assert.equal(written.ok, true)
    assert.deepEqual(written.result, PLAN_RESULT)

    assert.deepEqual(
      drv.calls.map((call) => [call.port, call.method]),
      [
        ['plugin', 'list'],
        ['plugin', 'read'],
        ['plugin', 'validate'],
        ['plugin', 'write'],
      ],
    )
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke：未知工具回 unknown_tool，且不触达管理平面', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const unknown = await drv.call('plugin-admin', 'invoke', { tool: 'plugin.nope', args: {} })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_tool')
    assert.equal(drv.calls.length, 0)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke：管理平面结构化错误原样透传（hidden_identity）', async () => {
  const drv = startService({
    planeHandler: (port, method) => {
      if (method === 'read') return { error: 'hidden_identity', message: 'sandbox' }
      return stubPlaneHandler(port, method, {})
    },
  })
  try {
    await drv.hello()
    const hidden = await drv.call('plugin-admin', 'invoke', {
      tool: 'plugin.read',
      args: { identity: 'sandbox', path: 'plugin.json' },
    })
    assert.equal(hidden.ok, false)
    assert.equal(hidden.error.code, 'hidden_identity')
    assert.equal(hidden.error.message, 'sandbox')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('invoke：tool 缺失 / 非对象 args → 协议级 bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const missing = await drv.callRaw('plugin-admin', 'invoke', { args: {} })
    assert.equal(missing.kind, 'error')
    assert.equal(missing.code, 'bad_args')
    const badArgs = await drv.callRaw('plugin-admin', 'invoke', 'not-an-object')
    assert.equal(badArgs.kind, 'error')
    assert.equal(badArgs.code, 'bad_args')
    assert.equal(drv.calls.length, 0)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── 结构化错误 ─────────────────────────────────────────────────────────────

test('未知能力 / 方法 → 结构化错误，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const badPort = await drv.callRaw('nope', 'describe', {})
    assert.equal(badPort.code, 'unresolved_cap')
    const badMethod = await drv.callRaw('plugin-admin', 'nope', {})
    assert.equal(badMethod.code, 'unknown_method')
    // 进程仍可服务
    const ok = await drv.call('plugin-admin', 'describe', {})
    assert.equal(ok.tools.length, 4)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── 包声明：工具面只消费 plugin one，自身不 pin host ────────────────────────

test('plugin.json：needs.plugin=one、pins 空、只实现 plugin-admin', () => {
  const decl = JSON.parse(readFileSync(join(PKG_ROOT, 'plugin.json'), 'utf8'))
  assert.deepEqual(decl.implements, ['plugin-admin', 'tool-provider'])
  assert.deepEqual(decl.methods, {
    'plugin-admin': ['describe', 'invoke'],
    'tool-provider': ['describe', 'invoke'],
  })
  assert.deepEqual(decl.pins, {})
  assert.deepEqual(decl.needs, { plugin: { mode: 'one' } })
})
