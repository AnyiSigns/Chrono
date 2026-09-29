// secrets-env 包形状 / 内容测试（零依赖，node --test）。
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
  'build',
  'protocol',
  'restart',
  'health',
  'state',
  'members',
  'commands',
]

test('plugin.json 13 字段齐全且形态合法（secrets-backend 提供方）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'secrets-env')
  assert.equal(decl.schema, 'schema/secrets-env.json')
  assert.deepEqual(decl.implements, ['secrets-backend'])
  assert.deepEqual(decl.methods, { 'secrets-backend': ['read', 'list', 'kinds'] })
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.needs, undefined)
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(typeof decl.restart, 'object')
  assert.equal(typeof decl.health, 'object')
  assert.equal(decl.health.interval_ms, 10000)
  assert.equal(decl.health.timeout_ms, 2000)
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('schema/secrets-env.json 声明 name 入参 / kinds / 失败码 / 脱敏 / 超时', () => {
  const schema = readJson('schema/secrets-env.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.properties.read_request.required, ['name'])
  assert.deepEqual(schema.properties.list_entry.required, ['name', 'has'])
  assert.deepEqual(schema.properties.backend_kinds.items, { type: 'string', const: 'env' })
  assert.ok(schema.audit_redact['secrets-backend.read'].includes('name'))
  assert.ok(schema.method_timeouts['secrets-backend.read'] > 0)
  assert.ok(schema.method_timeouts['secrets-backend.list'] > 0)
  assert.ok(schema.method_timeouts['secrets-backend.kinds'] > 0)
})

test('execute/ 源码文件齐全（帧编解码 / 帧循环走 plugin-sdk）', () => {
  for (const rel of ['execute/main.ts', 'execute/methods.ts', 'execute/types.ts']) {
    assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  }
})

test('package.json 零依赖且带测试脚本', () => {
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
