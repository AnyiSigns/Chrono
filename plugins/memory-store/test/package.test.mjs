// `memory-store` 包形状 / 声明 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

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

const DECL_FIELDS = [
  'identity',
  'schema',
  'implements',
  'methods',
  'pins',
  'start',
  'exclusive',
  'protocol',
  'restart',
  'health',
  'state',
  'members',
  'commands',
]

test('plugin.json 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'memory-store')
  assert.equal(decl.schema, 'schema/memory.json')
  assert.deepEqual(decl.implements, ['memory'])
  assert.deepEqual(decl.methods, { memory: ['put', 'read', 'search', 'list', 'append', 'delete', 'pin', 'edit'] })
  assert.deepEqual(decl.pins, { embedding: 'embedding' })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.deepEqual(decl.exclusive, ['data'])
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'durable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
  assert.equal(decl.health.probe, 'memory.search')
})

test('schema/memory.json：数据契约含 body / 条目形状与索引锚', () => {
  const schema = readJson('schema/memory.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.model, { id: 'granite-97m', dim: 384 })
  const props = schema.properties
  assert.equal(typeof props.body, 'object')
  assert.equal(typeof props.entry, 'object')
  assert.equal(typeof props.put_request, 'object')
  assert.equal(typeof props.read_request, 'object')
  assert.equal(typeof props.search_request, 'object')
  assert.deepEqual(props.body.properties.deleted.type, 'object')
  assert.deepEqual(props.body.properties.pinned.type, 'object')
  assert.equal(props.body.properties.model.properties.dim.minimum, 1)
  assert.equal(props.entry.properties.weight.maximum, 1)
  assert.equal(props.entry.properties.chunks.items.properties.start.minimum, 0)
  assert.deepEqual(props.put_result.properties.dedup.enum, ['vector', 'none'])
  assert.deepEqual(props.search_result.properties.status.enum, ['ready', 'index_building'])
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('execute/ 源码齐全且不 import 宿主 / 内核 / client / 其他插件包', () => {
  const files = readdirSync(join(PKG_ROOT, 'execute')).filter((name) => name.endsWith('.ts'))
  const expected = [
    'frames.ts',
    'heap.ts',
    'main.ts',
    'methods.ts',
    'plan.ts',
    'plugin.ts',
    'port-link.ts',
    'persist.ts',
    'store.ts',
    'types.ts',
    'vector-index.ts',
  ]
  assert.deepEqual(files.sort(), expected.sort())
  for (const name of files) {
    const source = readText(join('execute', name))
    assert.equal(/packages\/(host|kernel|client)/.test(source), false, `${name} 不应 import 宿主 / 内核 / client`)
    assert.equal(/from ['"]\.\.\/\.\.\//.test(source), false, `${name} 不应引用包外路径`)
  }
})

test('README / .worldignore / package.json 就位；测试与工具不入世界', () => {
  assert.ok(existsSync(join(PKG_ROOT, 'README.md')))
  const ignore = readText('.worldignore')
  assert.ok(ignore.split(/\r?\n/).includes('test/'))
  assert.ok(ignore.split(/\r?\n/).includes('tools/'))
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'memory-store')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.test, 'node --test')
})

test('红线：execute/ · src/ · terms/ · test/ 不出现宿主 / 内核 / client 引用', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['execute', 'src', 'terms', 'test']) {
    const dir = join(PKG_ROOT, root)
    if (!existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      assert.equal(forbidden.test(readFileSync(file, 'utf8')), false, `${file} 出现宿主 / 内核 / client 引用`)
    }
  }
})

test('红线：README 不含计划编号样式', () => {
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})
