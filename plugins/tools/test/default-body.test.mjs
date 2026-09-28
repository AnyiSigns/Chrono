// 默认绑定表（数据世代 body）包形状测试：记忆与检索工具绑定齐备、四要素完整、
// class 均为本插件已 pin 的逻辑端点、method 指向对应能力类实际暴露的方法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from './driver.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(rel) {
  return JSON.parse(readFileSync(join(PKG_ROOT, rel), 'utf8'))
}

const EXPECTED = {
  'memory.compress': { class: 'compress', method: 'summarize', idempotent: false },
  'memory.put': { class: 'memory', method: 'put', idempotent: false },
  'memory.read': { class: 'memory', method: 'read', idempotent: true },
  'memory.candidates': { class: 'memory-maintenance', method: 'candidates', idempotent: true },
  'retrieval.search': { class: 'retrieval', method: 'search', idempotent: true },
}

test('tools/default-body.json：记忆工具绑定齐备且形状合规', () => {
  const body = readJson('tools/default-body.json')
  const bindings = body.bindings
  assert.deepEqual(Object.keys(bindings).sort(), Object.keys(EXPECTED).sort())

  const pins = readJson('plugin.json').pins
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const item = bindings[name]
    assert.equal(item.class, expected.class, `${name}.class`)
    assert.equal(item.method, expected.method, `${name}.method`)
    assert.equal(item.idempotent, expected.idempotent, `${name}.idempotent`)
    assert.ok(Object.hasOwn(pins, item.class), `${name}.class ${item.class} 必须是本插件 pin 的逻辑端点`)
    for (const key of ['intent', 'when_to_use', 'boundaries']) {
      assert.equal(typeof item[key], 'string', `${name}.${key}`)
      assert.ok(item[key].trim().length > 0, `${name}.${key} 非空`)
    }
    assert.equal(typeof item.param_semantics, 'object', `${name}.param_semantics`)
    assert.equal(item.argsSchema.type, 'object', `${name}.argsSchema`)
  }
})

test('tools/default-body.json：检索绑定就位（class retrieval → pin memory-retrieval）', () => {
  const body = readJson('tools/default-body.json')
  const pins = readJson('plugin.json').pins
  const item = body.bindings['retrieval.search']
  assert.ok(item, '默认绑定表须含 retrieval.search')
  assert.equal(item.class, 'retrieval')
  assert.equal(item.method, 'search')
  assert.equal(item.idempotent, true)
  assert.equal(pins[item.class], 'memory-retrieval', 'retrieval 能力类须 pin memory-retrieval')
})

test('默认绑定表进目录：list 无拒绝，记忆工具可派发', async () => {
  const body = readJson('tools/default-body.json')
  const service = startService()
  try {
    await service.hello()
    const listed = await service.call('list', { tools_bindings: body })
    assert.equal(listed.kind, 'result', JSON.stringify(listed))
    assert.deepEqual(listed.value.rejected, [], JSON.stringify(listed.value.rejected))
    const names = listed.value.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, Object.keys(EXPECTED).sort())
    for (const tool of listed.value.tools) {
      assert.equal(tool.kind, 'binding')
      assert.equal(tool.provider, EXPECTED[tool.name].class)
      assert.equal(tool.method, EXPECTED[tool.name].method)
    }
  } finally {
    service.close()
  }
})

test('默认绑定表派发：memory.compress 走反向 port.call(compress.summarize)', async () => {
  const body = readJson('tools/default-body.json')
  const service = startService({ providers: { compress: { summarize: () => ({ ok: true, kind: 'summarize' }) } } })
  try {
    await service.hello()
    const listed = await service.call('list', { tools_bindings: body })
    const dispatched = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'memory.compress', args: { mode: 'algorithmic', goal: 'g' } }],
      directory: listed.value,
      verdicts: 'allow',
      conversation: 'c-1',
    })
    assert.equal(dispatched.kind, 'result', JSON.stringify(dispatched))
    assert.equal(dispatched.value.results[0].ok, true, JSON.stringify(dispatched.value.results[0]))
    const reverse = service.portCalls.find((frame) => frame.port === 'compress' && frame.method === 'summarize')
    assert.ok(reverse !== undefined, '应发 compress.summarize 反向调用')
    assert.equal(reverse.args.conversation, 'c-1', '调用方注入的 conversation 原样透传')
    assert.equal(reverse.args.goal, 'g')
  } finally {
    service.close()
  }
})

test('默认绑定表派发：retrieval.search 走反向 port.call(retrieval.search)', async () => {
  const body = readJson('tools/default-body.json')
  const service = startService({
    providers: { retrieval: { search: (args) => ({ ok: true, kind: 'search', recall: [], query: args.query }) } },
  })
  try {
    await service.hello()
    const listed = await service.call('list', { tools_bindings: body })
    assert.equal(listed.value.rejected.length, 0, JSON.stringify(listed.value.rejected))
    const dispatched = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'retrieval.search', args: { query: 'foo.ts 第 42 行' } }],
      directory: listed.value,
      verdicts: 'allow',
      workspace: 'w-1',
    })
    assert.equal(dispatched.kind, 'result', JSON.stringify(dispatched))
    assert.equal(dispatched.value.results[0].ok, true, JSON.stringify(dispatched.value.results[0]))
    const reverse = service.portCalls.find((frame) => frame.port === 'retrieval' && frame.method === 'search')
    assert.ok(reverse !== undefined, '应发 retrieval.search 反向调用')
    assert.equal(reverse.args.query, 'foo.ts 第 42 行')
    assert.equal(reverse.args.workspace, 'w-1', '调用方注入的 workspace 原样透传')
  } finally {
    service.close()
  }
})
