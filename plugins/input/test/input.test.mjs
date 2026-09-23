// input 包形状 / 内容测试（零依赖，node --test）。
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

const SLOT_KINDS = [
  'chat.message',
  'session.new',
  'session.select',
  'session.rename',
  'session.delete',
  'session.restore',
  'session.branch',
  'model.probe',
  'approval.decide',
  'question.answer',
  'workspace.add',
  'workspace.remove',
  'memory.edit',
  'idle',
]

const SLOT_FIELDS = [
  'kind',
  'text',
  'attachments',
  'conversation',
  'workspace_id',
  'title',
  'message',
  'workspace',
  'name',
  'path',
  'url',
  'protocol',
  'auth_ref',
  'id',
  'verdict',
  'answers',
  'action',
  'layer',
  'patch',
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

/** 递归断言 schema 落在 argsSchema 白名单子集内。 */
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
        assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), where)
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
  assert.equal(decl.identity, 'input')
  assert.equal(decl.schema, 'schema/slot.schema.json')
  assert.deepEqual(decl.implements, [])
  assert.deepEqual(decl.methods, {})
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, '')
  assert.equal(decl.protocol, '1')
  assert.equal(typeof decl.restart, 'object')
  assert.equal(typeof decl.health, 'object')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'term', path: 'terms/' },
    { kind: 'schema', path: 'schema/' },
  ])
})

test('commands 声明 input.read 且带 argsSchema', () => {
  const decl = readJson('plugin.json')
  assert.equal(decl.commands.length, 1)
  const command = decl.commands[0]
  assert.equal(command.name, 'input.read')
  assert.equal(command.entry, 'terms/input.read.json')
  assert.equal(command.argsSchema, 'schema/input.read.args.json')
  assert.equal(command.readonly, true)
})

test('slot schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/slot.schema.json'), 'slot.schema')
})

test('slot schema 顶层要求 slots 且 additionalProperties 为布尔', () => {
  const schema = readJson('schema/slot.schema.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['slots'])
  assert.equal(typeof schema.additionalProperties, 'boolean')
  assert.equal(schema.properties.slots.type, 'object')
})

test('slot schema 的 kind 枚举与字段齐全', () => {
  const props = readJson('schema/slot.schema.json').properties.slot.properties
  assert.deepEqual(props.kind.enum, SLOT_KINDS)
  for (const field of SLOT_FIELDS) {
    assert.ok(Object.hasOwn(props, field), `缺少槽字段 ${field}`)
  }
  assert.deepEqual(props.auth_ref.required, ['kind', 'name'])
  assert.deepEqual(props.action.enum, ['update', 'delete', 'pin'])
  assert.deepEqual(props.layer.enum, ['l1', 'l2', 'l3'])
  assert.deepEqual(props.verdict.enum, ['accept', 'deny'])
})

test('input.read argsSchema 符合白名单子集且声明可选 thread', () => {
  const args = readJson('schema/input.read.args.json')
  assertWhitelist(args, 'input.read.args')
  assert.equal(args.additionalProperties, false)
  assert.equal(args.properties.thread.type, 'string')
  assert.equal(args.required, undefined)
})

test('terms 是 JSON AST 且直出 input body', () => {
  assert.deepEqual(readJson('terms/input.read.json'), ['g', ['ids', 'input', 'body']])
})

test('tools/default-body.json 形状为 {slots:{}}', () => {
  assert.deepEqual(readJson('tools/default-body.json'), { slots: {} })
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
