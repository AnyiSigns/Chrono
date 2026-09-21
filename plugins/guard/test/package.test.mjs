// guard 包形状 / 内容测试（零依赖，node --test）。
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
  assert.equal(decl.identity, 'guard')
  assert.equal(decl.schema, 'schema/guard.json')
  assert.deepEqual(decl.implements, ['guard'])
  assert.deepEqual(decl.methods, { guard: ['judge'] })
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(typeof decl.restart, 'object')
  assert.equal(typeof decl.health, 'object')
  assert.equal(decl.health.probe, 'guard.judge')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('schema/guard.json 是合法 JSON 且声明 judge 形状', () => {
  const schema = readJson('schema/guard.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.properties.judge_request.required, ['calls'])
  assert.deepEqual(schema.properties.judge_decision.properties.verdict.enum, ['allow', 'escalate', 'deny'])
  assert.ok(schema.properties.judge_decision.properties.reason.enum.includes('mcp_untrusted'))
})

test('tools/default-body.json 是结构化规则（四段齐全）', () => {
  const body = readJson('tools/default-body.json')
  assert.equal(body.version, 1)
  assert.equal(typeof body.tiers.auto, 'object')
  assert.equal(body.workspace.enabled, true)
  assert.ok(Array.isArray(body.danger_patterns) && body.danger_patterns.length === 6)
  assert.equal(body.mcp.port, 'mcp')
  assert.equal(body.mcp.default_verdict, 'escalate')
  assert.equal(body.structural_writes.length, 2)
  assert.equal(body.deny.allowed_ports, null)
})

test('execute/ 源码与 tools/ 脚本齐全', () => {
  const files = [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/judge.ts',
    'execute/rules.ts',
    'execute/frames.ts',
    'execute/types.ts',
    'tools/seed-default-body.mjs',
    'tools/e2e-smoke.mjs',
  ]
  for (const rel of files) assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
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
