// tool-shell 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
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

test('plugin.json 12 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'tool-shell')
  assert.equal(decl.schema, 'schema/tool-shell.json')
  assert.deepEqual(decl.implements, ['tool-shell'])
  assert.deepEqual(decl.methods, { 'tool-shell': ['describe', 'invoke'] })
  assert.deepEqual(decl.pins, { secrets: 'secrets', sandbox: 'sandbox' })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
  assert.equal(decl.health.probe, 'tool-shell.describe')
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.commands, [])
})

test('schema/tool-shell.json 声明工具四要素、nullable tier 与方法级超时', () => {
  const schema = readJson('schema/tool-shell.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.tool.properties.name.const, 'shell')
  for (const key of ['intent', 'when_to_use', 'param_semantics', 'boundaries']) {
    assert.ok(schema.properties.tool.required.includes(key), `tool 缺四要素 ${key}`)
  }
  assert.deepEqual(schema.properties.tool.properties.default_caps.properties.net.enum, [
    'none',
    'limited',
    'all',
  ])
  const tier = schema.properties.invoke_bag.properties.tier
  assert.deepEqual(tier.type, ['string', 'null'])
  assert.ok(!tier.enum.includes('null'), 'tier 不应把字符串 "null" 当枚举值')
  assert.deepEqual(schema.method_timeouts, { 'tool-shell.invoke': 130000 })
})

test('execute/ 源码齐全', () => {
  const files = [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/describe.ts',
    'execute/invoke.ts',
    'execute/port-link.ts',
    'execute/frames.ts',
    'execute/plugin.ts',
    'execute/types.ts',
  ]
  for (const rel of files) assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
})

test('package.json 零依赖且 test = node --test', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('.worldignore 声明 test/ 与 tools/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
