// guard 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))



test('judge 判定住 term：产物为原语 AST，糖化源同包且不入世', () => {
  const entry = readJson('plugin.json').judgments.guard.judge
  assert.equal(entry, 'terms/guard.json')
  assert.ok(existsSync(join(PKG_ROOT, entry)), `缺少判定产物 ${entry}`)
  const ast = readJson(entry)
  assert.ok(Array.isArray(ast), '判定产物不是原语 AST')
  assert.equal(ast[0], 'call')
  assert.ok(existsSync(join(PKG_ROOT, 'terms.src/guard.json')), '缺少糖化源 terms.src/guard.json')
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

test('execute/ 取数侧源码与 tools/ 脚本齐全，且无 judge 运行时实现', () => {
  const files = [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/facts.ts',
    'execute/rules.ts',
    'execute/types.ts',
    'tools/seed-default-body.mjs',
    'tools/e2e-smoke.mjs',
  ]
  for (const rel of files) assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  assert.equal(existsSync(join(PKG_ROOT, 'execute', 'judge.ts')), false, 'judge 不应再住服务')
})

test('package.json 零依赖且带测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('.worldignore 声明 test/ 与 tools/ 与糖化源，不排除契约必需文件', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
  assert.ok(lines.includes('terms.src/'))
  for (const forbidden of ['plugin.json', 'package.json', 'README.md', 'schema/', 'terms/']) {
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
