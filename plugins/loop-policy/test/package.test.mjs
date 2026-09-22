// 包声明 / .worldignore / schema 的机械测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
const readText = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 递归列出目录下全部文件（含子目录）。 */
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else out.push(path)
  }
  return out
}

test('plugin.json：identity / implements / methods / pins / start / members / commands', () => {
  const plugin = read('plugin.json')
  assert.equal(plugin.identity, 'loop-policy')
  assert.deepEqual(plugin.implements, ['loop-policy'])
  assert.deepEqual(plugin.methods['loop-policy'], ['interpret'])
  assert.deepEqual(plugin.pins, {
    session: 'session',
    model: 'model-protocol',
    context: 'context-window',
    retrieval: 'memory-retrieval',
    guard: 'guard',
    approval: 'approval',
    tools: 'tools',
    router: 'router',
    'evolve-metrics': 'evolve-metrics',
  })
  assert.equal(plugin.start, 'node execute/main.ts')
  assert.equal(plugin.schema, 'schema/graph.json')
  assert.deepEqual(plugin.commands, [])
  const kinds = plugin.members.map((m) => m.kind).sort()
  assert.deepEqual(kinds, ['execute', 'schema'])
})

test('.worldignore 排除 test/ 与 tools/', () => {
  const text = readText('.worldignore')
  assert.match(text, /^test\/$/m)
  assert.match(text, /^tools\/$/m)
})

test('schema/graph.json：六类条目形状 + method_timeouts(H17)', () => {
  const schema = read('schema/graph.json')
  for (const key of ['contracts', 'nodes', 'prompts', 'graph', 'thresholds', 'refusal_codes']) {
    assert.ok(schema.properties[key], `缺条目 ${key}`)
  }
  assert.ok(schema.properties.contract_entry)
  assert.ok(schema.properties.scope_entry)
  assert.ok(schema.properties.graph_entry)
  assert.equal(schema.method_timeouts['loop-policy.interpret'], 600000)
})

test('package.json：type=module 且 test = node --test', () => {
  const pkg = read('package.json')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.test, 'node --test')
})

test('红线：execute/ · src/ · terms/ · test/ 不出现宿主 / 内核 / client 引用', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['execute', 'src', 'terms', 'test']) {
    const dir = join(ROOT, root)
    if (!existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      assert.equal(forbidden.test(readFileSync(file, 'utf8')), false, `${file} 出现宿主 / 内核 / client 引用`)
    }
  }
})

test('红线：README 不含计划编号样式', () => {
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})
