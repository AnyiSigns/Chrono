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

function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else out.push(path)
  }
  return out
}

test('plugin.json：identity / implements / methods / pins / needs / start / members', () => {
  const plugin = read('plugin.json')
  assert.equal(plugin.identity, 'graph-run')
  assert.deepEqual(plugin.implements, ['graph-run'])
  assert.deepEqual(plugin.methods['graph-run'], ['run', 'cancel'])
  assert.deepEqual(plugin.concurrent_methods, ['run', 'cancel'])
  assert.deepEqual(plugin.pins, {})
  assert.deepEqual(plugin.needs, {
    session: { mode: 'one' },
    model: { mode: 'one' },
    context: { mode: 'one' },
    guard: { mode: 'one' },
    'graph-gate': { mode: 'one' },
    approval: { mode: 'one' },
    tools: { mode: 'one' },
    router: { mode: 'one' },
  })
  assert.equal(plugin.start, 'node execute/main.ts')
  assert.deepEqual(plugin.members.map((m) => m.kind).sort(), ['execute', 'schema'])
})

test('.worldignore 排除 test/ 与 tools/', () => {
  const text = readText('.worldignore')
  assert.match(text, /^test\/$/m)
  assert.match(text, /^tools\/$/m)
})

test('schema：method_timeouts 覆盖 run / cancel 且 run 落在门面与内层之间', () => {
  const schema = read('schema/graph-run.json')
  assert.equal(schema.method_timeouts['graph-run.run'], 4000000)
  assert.equal(schema.method_timeouts['graph-run.cancel'], 30000)
  // 严格嵌套：门面反向上限 4200000 > run 4000000 > 内层 model.chat 3600000。
  assert.ok(3600000 < schema.method_timeouts['graph-run.run'])
  assert.ok(schema.method_timeouts['graph-run.run'] < 4200000)
})

test('package.json：type=module 且 test = node --test', () => {
  const pkg = read('package.json')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.test, 'node --test')
})

test('红线：execute/ · test/ 不出现宿主 / 内核 / client 引用', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['execute', 'test']) {
    const dir = join(ROOT, root)
    if (!existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      assert.equal(
        forbidden.test(readFileSync(file, 'utf8')),
        false,
        `${file} 出现宿主 / 内核 / client 引用`,
      )
    }
  }
})

test('红线：README 不含计划编号样式', () => {
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})
