// vendor-deepseek 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

const DECL_FIELDS = [
  'identity', 'schema', 'implements', 'methods', 'pins', 'start',
  'protocol', 'restart', 'health', 'state', 'members', 'commands',
]
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
])
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples'])

function assertWhitelist(schema, where) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), where)
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue
    assert.ok(KEYWORDS.has(key), where + '.' + key + ' 不在白名单')
    const value = schema[key]
    switch (key) {
      case 'type':
        assert.equal(typeof value, 'string', where + '.type')
        assert.ok(TYPES.has(value), where + '.type 非法：' + value)
        break
      case 'properties':
        for (const [name, child] of Object.entries(value)) assertWhitelist(child, where + '.properties.' + name)
        break
      case 'items':
        assertWhitelist(value, where + '.items')
        break
      case 'required':
        assert.ok(Array.isArray(value) && value.every((x) => typeof x === 'string'), where)
        break
      case 'additionalProperties':
        assert.equal(typeof value, 'boolean', where + '.additionalProperties 只能布尔')
        break
      case 'enum':
        assert.ok(Array.isArray(value) && value.length > 0, where + '.enum')
        break
      case 'minimum':
      case 'maximum':
        assert.equal(typeof value, 'number', where + '.' + key)
        break
      case 'minItems':
      case 'maxItems':
      case 'minLength':
      case 'maxLength':
        assert.ok(Number.isInteger(value) && value >= 0, where + '.' + key)
        break
      default:
        break
    }
  }
}

const EXPECTED = {
  "identity": "vendor-deepseek",
  "name": "DeepSeek",
  "sdk": "deepseek",
  "baseUrl": "https://api.deepseek.com/v1",
  "authRef": "DEEPSEEK_API_KEY",
  "defaultReasoning": [
    "low",
    "medium",
    "high"
  ],
  "impl": "protocol",
  "protocol": "openai-chat",
  "sdkPackage": null,
  "authStyle": "bearer",
  "authHeader": null,
  "systemRole": "system",
  "reasoningField": "reasoning_effort",
  "reasoningMap": {
    "low": "low",
    "medium": "high",
    "high": "high"
  },
  "reasoningResponseField": "reasoning_content",
  "maxTokensField": "max_tokens",
  "bodyKeys": [
    "default_auth_ref_name",
    "default_base_url",
    "default_reasoning",
    "name",
    "quirks",
    "sdk"
  ]
}

const SCHEMA_TOP_KEYS = ['name', 'sdk', 'default_base_url', 'default_auth_ref_name', 'default_reasoning', 'quirks']
const QUIRKS_KEYS = ['impl', 'protocol', 'sdk_package', 'auth_style', 'auth_header', 'system_role', 'reasoning_field', 'reasoning_map', 'reasoning_response_field', 'max_tokens_field', 'models_path', 'stream_usage', 'extra_headers', 'note']

test('plugin.json 12 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, EXPECTED.identity)
  assert.equal(decl.schema, 'schema/vendor.json')
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

test('schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/vendor.json'), 'vendor.schema')
})

test('schema 顶层与 quirks 键集为七包同形状', () => {
  const schema = readJson('schema/vendor.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['name', 'sdk', 'default_base_url', 'default_auth_ref_name', 'quirks'])
  assert.deepEqual(Object.keys(schema.properties).sort(), [...SCHEMA_TOP_KEYS].sort())
  assert.deepEqual(Object.keys(schema.properties.quirks.properties).sort(), [...QUIRKS_KEYS].sort())
  assert.deepEqual(schema.properties.quirks.properties.auth_style.enum, ['bearer', 'query', 'header'])
  assert.deepEqual(schema.properties.quirks.properties.impl.enum, ['protocol', 'sdk'])
  assert.deepEqual(schema.properties.quirks.properties.system_role.enum, ['system', 'developer'])
})

test('default-body 取值与厂商核对结论一致', () => {
  const body = readJson('tools/default-body.json')
  assert.deepEqual(Object.keys(body).sort(), EXPECTED.bodyKeys)
  assert.equal(body.name, EXPECTED.name)
  assert.equal(body.sdk, EXPECTED.sdk)
  assert.equal(body.default_base_url, EXPECTED.baseUrl)
  assert.equal(body.default_auth_ref_name, EXPECTED.authRef)
  if (EXPECTED.defaultReasoning === null) assert.equal(body.default_reasoning, undefined)
  else assert.deepEqual(body.default_reasoning, EXPECTED.defaultReasoning)
  const q = body.quirks
  assert.equal(q.impl, EXPECTED.impl)
  assert.equal(q.protocol, EXPECTED.protocol)
  assert.equal(q.sdk_package, EXPECTED.sdkPackage)
  assert.equal(q.auth_style, EXPECTED.authStyle)
  assert.equal(q.auth_header, EXPECTED.authHeader)
  assert.equal(q.system_role, EXPECTED.systemRole)
  assert.equal(q.reasoning_field, EXPECTED.reasoningField)
  assert.deepEqual(q.reasoning_map, EXPECTED.reasoningMap)
  assert.equal(q.reasoning_response_field, EXPECTED.reasoningResponseField)
  assert.equal(q.max_tokens_field, EXPECTED.maxTokensField)
  assert.equal(q.models_path, '/models')
  assert.equal(q.stream_usage, 'final_chunk')
  assert.deepEqual(q.extra_headers, {})
  assert.ok(q.note.length > 0)
})

test('reasoning_map 值类型合法；auth_header 仅 header 厂商非 null', () => {
  const q = readJson('tools/default-body.json').quirks
  for (const value of Object.values(q.reasoning_map)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), 'reasoning_map 值类型非法：' + typeof value)
  }
  if (q.auth_style === 'header') assert.equal(typeof q.auth_header, 'string')
  else assert.equal(q.auth_header, null)
})


test('.worldignore 声明 test/ 与 tools/', () => {
  const lines = readText('.worldignore').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'))
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
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
