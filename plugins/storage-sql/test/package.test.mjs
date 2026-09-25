// storage-sql 包形状 / 声明合法性测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

const DECL_FIELDS = [
  'identity',
  'schema',
  'implements',
  'methods',
  'pins',
  'start',
  'build',
  'exclusive',
  'protocol',
  'restart',
  'health',
  'state',
  'members',
  'commands',
]

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
])
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples'])

function assertWhitelist(schema, where) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), where)
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue
    assert.ok(KEYWORDS.has(key), `${where}.${key} 不在白名单`)
    const value = schema[key]
    if (key === 'type') {
      assert.ok(TYPES.has(value), `${where}.type 非法：${value}`)
    } else if (key === 'properties') {
      for (const [name, child] of Object.entries(value)) assertWhitelist(child, `${where}.properties.${name}`)
    } else if (key === 'items') {
      assertWhitelist(value, `${where}.items`)
    }
  }
}

test('plugin.json 14 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'storage-sql')
  assert.equal(decl.schema, 'schema/storage-sql.json')
  assert.deepEqual(decl.implements, ['storage-sql'])
  assert.deepEqual(decl.methods['storage-sql'], [
    'createTable',
    'query',
    'write',
    'batch',
    'listTables',
    'info',
    'dropNamespace',
  ])
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, 'node execute/main.ts')
  assert.deepEqual(decl.build, [])
  assert.deepEqual(decl.exclusive, [])
  assert.equal(decl.protocol, '1')
  assert.equal(typeof decl.restart, 'object')
  assert.equal(typeof decl.health, 'object')
  assert.equal(decl.state, 'durable')
  assert.deepEqual(
    decl.members.map((member) => member.kind).sort(),
    ['execute', 'schema'],
  )
  assert.deepEqual(decl.commands, [])
})

test('storage-sql schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/storage-sql.json'), 'storage-sql.schema')
})

test('.worldignore 声明 test/ 与 tools/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
})

test('package.json 零依赖、node>=24、带测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.engines.node, '>=24')
  assert.equal(pkg.scripts.test, 'node --test')
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})

test('execute/ 不 import 宿主 / 内核 / 其他插件包', () => {
  for (const file of ['frames.ts', 'engine.ts', 'methods.ts', 'main.ts', 'types.ts']) {
    const text = readText(join('execute', file))
    assert.ok(!text.includes('packages/host'), `${file} 引用宿主`)
    assert.ok(!text.includes('packages/kernel'), `${file} 引用内核`)
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1]
      assert.ok(spec.startsWith('.') || spec.startsWith('node:'), `${file} 非法依赖 ${spec}`)
    }
  }
})
