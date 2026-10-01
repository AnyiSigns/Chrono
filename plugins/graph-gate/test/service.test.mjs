// `graph-gate` 协议级 + 确定性测试（node --test）：validate / closure / select / hash 三方法同输入同输出，
// 且 validate 错误码 / 结果哈希与权威实现对拍一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'
import { validateGraphData } from '../execute/gate.ts'
import { H } from '../execute/hash.ts'
import { seedModel } from './fixtures.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

const PINS = {
  session: 'session',
  model: 'model-protocol',
  context: 'context-window',
  guard: 'guard',
  approval: 'approval',
  'tool-dispatch': 'tool-dispatch',
  router: 'router',
  'evolve-metrics': 'evolve-metrics',
}

function wrapperOf(model) {
  return {
    contracts: model.contracts,
    nodes: model.nodes,
    prompts: model.prompts,
    graph: model.graph,
    thresholds: model.thresholds,
    refusal_codes: model.refusalCodes,
  }
}

/** 最小合法图：单契约单节点（closure / select 用）。 */
function tinyModel() {
  const contract = {
    contract_id: 'c1',
    inputs: [],
    outputs: [{ name: 'out', type: 'any' }],
    effects: { ports: [] },
    touches_effects: false,
  }
  return {
    contracts: [contract],
    nodes: [
      {
        node_id: 'n-global',
        contract_id: 'c1',
        impl: 'atomic',
        bindings: {},
        scope: { kind: 'global' },
      },
      {
        node_id: 'n-ws',
        contract_id: 'c1',
        impl: 'atomic',
        bindings: {},
        scope: { kind: 'workspace', workspace_id: 'w1' },
      },
    ],
    prompts: {},
    graph: { nodes: ['c1'], edges: [], entry_supply: [{ type_id: 'task' }], loop: {}, sink: 0 },
    thresholds: {},
    refusalCodes: [],
  }
}

/** SDK 驱动适配：能力类固定，反向调用不被使用。 */
function startService() {
  const drv = startSdkService({ entry: ENTRY, cwd: PKG_ROOT, timeoutMs: 15000 })
  return { ...drv, hello: () => drv.hello('graph-gate') }
}

async function callValue(drv, method, args) {
  const message = await drv.call('graph-gate', method, args)
  assert.equal(message.kind, 'result', JSON.stringify(message))
  return message.value
}

test('hello 回 manifest：四方法声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'graph-gate')
    assert.deepEqual(manifest.implements, ['graph-gate'])
    assert.deepEqual(manifest.methods['graph-gate'], ['validate', 'closure', 'select', 'hash'])
    assert.equal(manifest.state, 'recomputable')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：错误码 / result_hash 与权威实现对拍，且同输入同输出', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const wrapper = wrapperOf(seedModel())
    const args = { graph: wrapper, pins: PINS, active_graph: null, runs_since_fork: null }
    const first = await callValue(drv, 'validate', args)
    const second = await callValue(drv, 'validate', args)
    const expected = validateGraphData(args)
    assert.deepEqual(first.errors, expected.errors)
    assert.equal(first.result_hash, expected.result_hash)
    assert.equal(first.result_hash, second.result_hash)
    assert.equal(first.ok, false)
    assert.deepEqual(
      first.errors.map((error) => error.code),
      ['fork_only'],
    )
    assert.equal(drv.portCalls.length, 0, 'validate 不得发反向调用')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('closure：合法图 ok + 拓扑视图；未声明契约报 unknown_contract', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const ok = await callValue(drv, 'closure', { graph: wrapperOf(tinyModel()) })
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.errors, [])
    assert.deepEqual(ok.view, { n: 1, sink: 0, order: [0] })

    const broken = tinyModel()
    broken.graph.nodes = ['c1', 'missing']
    broken.graph.edges = [{ from: [0, 'out'], to: [1, 'in'] }]
    broken.graph.sink = 1
    const bad = await callValue(drv, 'closure', { graph: wrapperOf(broken) })
    assert.equal(bad.ok, false)
    assert.ok(bad.errors.some((error) => error.code === 'unknown_contract'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('select：按 workspace 过滤 + 隔离升序确定性取首；无匹配回 null', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const graph = wrapperOf(tinyModel())
    const workspace = await callValue(drv, 'select', {
      graph,
      contract_id: 'c1',
      workspace_id: 'w1',
    })
    assert.equal(workspace.ok, true)
    assert.equal(workspace.instance.chosen_instance, 'n-ws')
    const global = await callValue(drv, 'select', { graph, contract_id: 'c1', workspace_id: null })
    assert.equal(global.instance.chosen_instance, 'n-global')
    const missing = await callValue(drv, 'select', { graph, contract_id: 'nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'contract_not_found')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('hash：与内核口径 H 一致，同输入同输出', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = { nodes: ['a', 'b'], sink: 1, nested: { z: 1, a: 2 } }
    const first = await callValue(drv, 'hash', { value })
    const second = await callValue(drv, 'hash', { value })
    assert.equal(first.hash, H(value))
    assert.equal(first.hash, second.hash)
  } finally {
    drv.close()
    await drv.exit
  }
})

test('结构化错误：缺 graph / 缺必填键 / 未知方法各回码', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const missing = await callValue(drv, 'validate', {
      pins: {},
      active_graph: null,
      runs_since_fork: null,
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.errors[0].code, 'graph_missing')
    const badSelect = await drv.call('graph-gate', 'select', { graph: wrapperOf(tinyModel()) })
    assert.equal(badSelect.kind, 'error')
    assert.equal(badSelect.code, 'bad_args')
    const badHash = await drv.call('graph-gate', 'hash', {})
    assert.equal(badHash.kind, 'error')
    assert.equal(badHash.code, 'bad_args')
    const unknown = await drv.call('graph-gate', 'nope', {})
    assert.equal(unknown.code, 'unknown_method')
  } finally {
    drv.close()
    await drv.exit
  }
})
