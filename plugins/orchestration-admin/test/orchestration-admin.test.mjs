// `orchestration-admin` 服务协议级测试（node --test）：自实现最小协议驱动，覆盖
// describe 四要素与工具卡、invoke 按工具名反向派发到 orchestration.*、远端失败原码回带、
// 结构化错误。编排行为本体归 orchestration，其自测覆盖；本插件不自实现编排逻辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

/** 假编排平面：只在本测试进程内仿真反向 `port.call orchestration.*` 应答（与真实契约同形）。 */
function answerOrchestration(message) {
  if (message.port !== 'orchestration') {
    return { ok: false, code: 'unresolved_cap', message: `${message.port}.${message.method}` }
  }
  const args = message.args ?? {}
  if (args.simulate_error === true) {
    return { ok: false, code: 'evidence_required', message: 'no evidence' }
  }
  if (message.method === 'list') {
    return {
      ok: true,
      value: {
        ok: true,
        graph_present: true,
        graph: { node_count: 3 },
        scopes: [],
        contracts: [],
        thresholds: {},
      },
    }
  }
  if (message.method === 'read') {
    return {
      ok: true,
      value: { ok: true, kind: 'graph', target: '', entry: { sink: 2 }, related_evidence: [] },
    }
  }
  if (message.method === 'validate') {
    return { ok: true, value: { ok: true, errors: [], result_hash: 'a'.repeat(64) } }
  }
  if (message.method === 'propose') {
    return {
      ok: true,
      value: {
        $directives: [
          { kind: 'write', request: { op: 'batch', args: { ops: [] } } },
          { kind: 'extern', payload: { ok: true } },
        ],
      },
    }
  }
  return { ok: false, code: 'unknown_method', message: message.method }
}

/** SDK 驱动适配：握手实现名固定；反向调用由本地假 `orchestration` 应答，插件间不得直连。 */
function startService() {
  const drv = startSdkService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    timeoutMs: 15000,
    onPortCall: answerOrchestration,
  })
  return { ...drv, hello: () => drv.hello('orchestration-admin') }
}

async function callValue(drv, port, method, args) {
  const message = await drv.call(port, method, args)
  assert.equal(message.kind, 'result', JSON.stringify(message))
  return message.value
}

// ── 握手 / 控制 / 自退出 ────────────────────────────────────────────────────

test('hello 回 manifest：能力类与方法声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'orchestration-admin')
    assert.deepEqual(manifest.implements, ['orchestration-admin', 'tool-provider'])
    assert.deepEqual(manifest.methods['orchestration-admin'], ['describe', 'invoke'])
    assert.deepEqual(manifest.methods['tool-provider'], ['describe', 'invoke'])
    assert.equal(manifest.state, 'recomputable')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('probe → pong / drain → bye / stdin EOF 自退出', async () => {
  const drv = startService()
  await drv.hello()
  assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
  assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  await drv.exit
})

// ── describe ────────────────────────────────────────────────────────────────

test('describe：四工具 + 描述四要素 + render（solid）+ caps 含 fs.read / net 字符串', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await callValue(drv, 'orchestration-admin', 'describe', {})
    assert.deepEqual(
      value.tools.map((tool) => tool.name),
      [
        'orchestration.list',
        'orchestration.read',
        'orchestration.validate',
        'orchestration.propose',
      ],
    )
    for (const tool of value.tools) {
      for (const field of ['intent', 'when_to_use', 'param_semantics', 'boundaries']) {
        assert.ok(tool[field] !== undefined, `${tool.name} 缺 ${field}`)
      }
      for (const key of tool.argsSchema.required ?? []) {
        assert.ok(tool.param_semantics[key] !== undefined, `${tool.name} param_semantics 缺 ${key}`)
      }
      assert.equal(tool.render.form, 'card')
      assert.equal(tool.render.label, 'orchestration')
      assert.equal(tool.render.tone, 'solid')
      assert.equal(typeof tool.caps.fs.read, 'string')
      assert.equal(typeof tool.caps.net, 'string')
    }
    assert.equal(
      value.tools.find((tool) => tool.name === 'orchestration.propose').idempotent,
      false,
    )
    assert.equal(
      value.tools.find((tool) => tool.name === 'orchestration.propose').render.detail.kind,
      'diff',
    )
    assert.equal(drv.portCalls.length, 0, 'describe 不得发反向调用')
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── invoke：派发 ─────────────────────────────────────────────────────────────

test('invoke：按工具名反向派发到 orchestration.*，args 原样透传', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const listed = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.list',
      args: { graph: { graph: { nodes: [] } } },
    })
    assert.equal(listed.ok, true)
    assert.equal(listed.result.graph.node_count, 3)
    assert.equal(drv.portCalls.at(-1).port, 'orchestration')
    assert.equal(drv.portCalls.at(-1).method, 'list')
    assert.deepEqual(drv.portCalls.at(-1).args, { graph: { graph: { nodes: [] } } })

    const read = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.read',
      args: { kind: 'graph', target: '' },
    })
    assert.equal(read.ok, true)
    assert.equal(read.result.entry.sink, 2)

    const unknown = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.nope',
      args: {},
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_tool')

    const proposed = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.propose',
      args: { class: 'binding', evidence_ids: ['ev-9'] },
    })
    assert.equal(proposed.ok, true)
    assert.equal(proposed.result.$directives[0].request.op, 'batch')
    assert.equal(drv.portCalls.at(-1).method, 'propose')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('invoke：远端结构化失败原码回带为 {ok:false,error}（不炸本轮）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const failed = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.propose',
      args: { simulate_error: true },
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'evidence_required')
    assert.equal(failed.error.message, 'no evidence')
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── 结构化错误 ─────────────────────────────────────────────────────────────

test('未知能力 / 方法 / 非对象 args → 结构化错误，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const badPort = await drv.call('nope', 'list', {})
    assert.equal(badPort.code, 'unresolved_cap')
    const plane = await drv.call('orchestration', 'list', {})
    assert.equal(plane.code, 'unresolved_cap', '编排平面方法归 orchestration，本服务不实现')
    const badMethod = await drv.call('orchestration-admin', 'nope', {})
    assert.equal(badMethod.code, 'unknown_method')
    const badArgs = await drv.call('orchestration-admin', 'describe', 'not-an-object')
    assert.equal(badArgs.code, 'bad_args')
    const ok = await callValue(drv, 'orchestration-admin', 'describe', {})
    assert.ok(Array.isArray(ok.tools))
  } finally {
    drv.close()
    await drv.exit
  }
})
