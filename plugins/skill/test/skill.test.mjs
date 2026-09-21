// skill 包形状 / 内容测试（零依赖，node --test）。
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
  assert.equal(decl.identity, 'skill')
  assert.equal(decl.schema, 'schema/skill.json')
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

test('skill schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/skill.json'), 'skill.schema')
})

test('skill schema 顶层为内联 skills 列表', () => {
  const schema = readJson('schema/skill.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['version', 'skills'])
  assert.equal(schema.properties.skills.type, 'array')
  assert.equal(schema.properties.skills.items.type, 'object')
})

test('skill 触发字段齐全且形状写入 description', () => {
  const schema = readJson('schema/skill.json')
  const item = schema.properties.skills.items
  const triggers = item.properties.triggers
  assert.equal(triggers.type, 'object')
  for (const field of ['keywords', 'file_globs', 'explicit']) {
    assert.equal(triggers.properties[field].type, 'array', `triggers.${field}`)
    assert.equal(triggers.properties[field].items.type, 'string', `triggers.${field}.items`)
  }
  for (const field of ['keywords', 'file_globs', 'explicit']) {
    assert.ok(triggers.description.includes(field), `triggers.description 缺 ${field}`)
    assert.ok(schema.description.includes(field), `顶层 description 缺 ${field}`)
  }
})

test('skill scope / body / enabled 字段齐全', () => {
  const item = readJson('schema/skill.json').properties.skills.items
  assert.deepEqual(item.properties.scope.properties.kind.enum, ['global', 'workspace', 'session'])
  assert.equal(item.properties.body.type, 'string')
  assert.equal(item.properties.enabled.type, 'boolean')
  assert.ok(item.required.includes('triggers'))
  assert.ok(item.required.includes('body'))
})

test('tools/default-body.json 为空技能清单', () => {
  assert.deepEqual(readJson('tools/default-body.json'), { version: 1, skills: [] })
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
