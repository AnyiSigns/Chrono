// agents 包形状 / 内容测试（零依赖，node --test）。
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
    switch (key) {
      case 'type':
        assert.equal(typeof value, 'string', `${where}.type`)
        assert.ok(TYPES.has(value), `${where}.type 非法：${value}`)
        break
      case 'properties':
        for (const [name, child] of Object.entries(value)) {
          assertWhitelist(child, `${where}.properties.${name}`)
        }
        break
      case 'items':
        assertWhitelist(value, `${where}.items`)
        break
      case 'required':
        assert.ok(Array.isArray(value) && value.every((x) => typeof x === 'string'), where)
        break
      case 'additionalProperties':
        assert.equal(typeof value, 'boolean', `${where}.additionalProperties 只能布尔`)
        break
      case 'enum':
        assert.ok(Array.isArray(value) && value.length > 0, `${where}.enum`)
        break
      case 'minimum':
      case 'maximum':
        assert.equal(typeof value, 'number', `${where}.${key}`)
        break
      case 'minItems':
      case 'maxItems':
      case 'minLength':
      case 'maxLength':
        assert.ok(Number.isInteger(value) && value >= 0, `${where}.${key}`)
        break
      default:
        break
    }
  }
}

test('plugin.json 12 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'agents')
  assert.equal(decl.schema, 'schema/agents.json')
  assert.deepEqual(decl.implements, [])
  assert.deepEqual(decl.methods, {})
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, '')
  assert.equal(decl.protocol, '1')
  assert.equal(typeof decl.restart, 'object')
  assert.equal(typeof decl.health, 'object')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [{ kind: 'schema', path: 'schema/' }])
  assert.deepEqual(decl.commands, [])
})

test('agents schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/agents.json'), 'agents.schema')
})

test('agents schema 三条链结构齐全（tail + count）', () => {
  const schema = readJson('schema/agents.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['version', 'templates', 'instances', 'channels'])
  for (const chain of ['templates', 'instances', 'channels']) {
    const slot = schema.properties[chain]
    assert.equal(slot.type, 'object', chain)
    assert.deepEqual(slot.required, ['tail', 'count'], chain)
    assert.ok(slot.properties.tail, `${chain}.tail 缺失`)
    assert.equal(slot.properties.count.type, 'integer', chain)
  }
})

test('agents 实例条目人格字段齐全', () => {
  const instance = readJson('schema/agents.json').properties.instance
  for (const field of [
    'id',
    'name',
    'system_prompt',
    'model',
    'decoding',
    'prefer_tools',
    'scope',
    'prev',
  ]) {
    assert.ok(instance.properties[field], `instance.${field} 缺失`)
  }
  assert.deepEqual(instance.properties.system_prompt.required, ['def'])
  assert.deepEqual(instance.properties.scope.properties.kind.enum, [
    'global',
    'workspace',
    'session',
  ])
  assert.deepEqual(instance.required, ['id', 'name', 'system_prompt', 'scope', 'prev'])
})

test('agents 模板 / 通道条目形状在 schema 中登记', () => {
  const schema = readJson('schema/agents.json')
  assert.deepEqual(schema.properties.template.required, ['id', 'name', 'system_prompt', 'scope', 'prev'])
  assert.deepEqual(schema.properties.channel.required, ['id', 'from', 'text', 'at', 'prev'])
  assert.ok(schema.properties.channel.properties.to, 'channel.to 缺失')
})

test('tools/default-body.json 为三条空链', () => {
  assert.deepEqual(readJson('tools/default-body.json'), {
    version: 1,
    templates: { tail: null, count: 0 },
    instances: { tail: null, count: 0 },
    channels: { tail: null, count: 0 },
  })
})

test('.worldignore 声明 test/ 与 tools/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
})

test('package.json 零依赖且带测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式 #<数字>')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
