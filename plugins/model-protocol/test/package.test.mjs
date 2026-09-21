// `model-protocol` 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

const DECL_FIELDS = ['identity', 'schema', 'implements', 'methods', 'pins', 'start', 'protocol', 'restart', 'health', 'state', 'members', 'commands']

test('plugin.json 12 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'model-protocol')
  assert.equal(decl.schema, 'schema/protocol.json')
  assert.deepEqual(decl.implements, ['model'])
  assert.deepEqual(decl.methods, { model: ['chat', 'complete', 'vendors', 'discover', 'profile', 'sync'] })
  assert.deepEqual(decl.pins, { secrets: 'secrets' })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
  assert.equal(decl.health.probe, 'model.chat')
})

test('schema 顶层含宿主消费键 periodic / method_timeouts 与自用 resilience', () => {
  const schema = readJson('schema/protocol.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.periodic.length, 1)
  assert.equal(schema.periodic[0].method, 'sync')
  assert.equal(typeof schema.periodic[0].every_ms, 'number')
  assert.deepEqual(schema.periodic[0].reads.config, ['ids', 'config', 'body'])
  assert.deepEqual(schema.periodic[0].reads['vendor-openai'], ['ids', 'vendor-openai', 'body'])
  assert.deepEqual(schema.periodic[0].reads['vendor-custom'], ['ids', 'vendor-custom', 'body'])
  assert.equal(schema.method_timeouts['model.chat'] >= 300000, true)
  assert.equal(schema.method_timeouts['model.complete'] >= 60000, true)
  assert.equal(typeof schema.resilience.max_retries, 'number')
  assert.equal(typeof schema.properties.chat_request, 'object')
  assert.equal(typeof schema.properties.profile_request, 'object')
  assert.equal(typeof schema.properties.delta_event, 'object')
})

test('execute 源码与 test / tools 齐全', () => {
  const files = [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/chat.ts',
    'execute/adapters.ts',
    'execute/discover.ts',
    'execute/profile.ts',
    'execute/vendors.ts',
    'execute/sdk-google.ts',
    'execute/resilience.ts',
    'execute/http.ts',
    'execute/stream.ts',
    'execute/quirks.ts',
    'execute/port-link.ts',
    'execute/errors.ts',
    'execute/plan.ts',
    'execute/frames.ts',
    'execute/types.ts',
    'execute/events.ts',
    'execute/plugin.ts',
    'tools/e2e-smoke.mjs',
  ]
  for (const rel of files) assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
})

test('package.json：@google/genai 钉版本依赖 + 测试脚本；lockfile 存在', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.test, 'node --test')
  const version = pkg.dependencies['@google/genai']
  assert.match(version, /^\d+\.\d+\.\d+$/, 'SDK 依赖必须钉精确版本')
  assert.ok(existsSync(join(PKG_ROOT, 'package-lock.json')), '缺少 package-lock.json')
  assert.equal(readJson('package-lock.json').packages['node_modules/@google/genai'].version, version)
})

test('.worldignore 排除 test/ tools/ node_modules/ target/，不排除契约必需文件', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  for (const required of ['test/', 'tools/', 'node_modules/', 'target/']) {
    assert.ok(lines.includes(required), `缺少排除 ${required}`)
  }
  for (const forbidden of ['plugin.json', 'package.json', 'README.md', 'schema/', 'execute/']) {
    assert.equal(lines.includes(forbidden), false, `不得排除契约必需文件 ${forbidden}`)
  }
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
