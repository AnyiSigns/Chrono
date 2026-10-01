// `router` 包形状 / 内容测试（零依赖，node --test）。
// `router.select` 判定已进 term（`plugin.json.judgments`），本包无执行件；
// 判定语义测试住宿主侧（`packages/host`），本包只测包形状与产物。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))



test('select 判定住 term：产物为原语 AST，糖化源同包且不入世', () => {
  const entry = readJson('plugin.json').judgments.router.select
  assert.equal(entry, 'terms/select.json')
  assert.ok(existsSync(join(PKG_ROOT, entry)), `缺少判定产物 ${entry}`)
  const ast = readJson(entry)
  assert.ok(Array.isArray(ast), '判定产物不是原语 AST')
  assert.equal(ast[0], 'if')
  assert.ok(existsSync(join(PKG_ROOT, 'terms.src/select.json')), '缺少糖化源 terms.src/select.json')
})

test('无执行件：无 execute/ 目录、start 为空、members 无 execute', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'execute')), false, '不应有 execute/')
  const decl = readJson('plugin.json')
  assert.equal(decl.start, '')
  assert.equal(
    decl.members.some((member) => member.kind === 'execute'),
    false,
  )
})

test('schema/router.json 冻结形状 {primary, aliases} 且声明默认值', () => {
  const schema = readJson('schema/router.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['primary', 'aliases'])
  assert.equal(schema.properties.primary.type, 'string')
  assert.equal(schema.properties.primary.default, 'model')
  assert.equal(schema.properties.aliases.type, 'array')
  assert.deepEqual(schema.properties.aliases.default, [])
})

test('package.json 零依赖且 test = node --test', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('.worldignore 声明 test/ / tools/ / terms.src/，不排除契约必需文件', () => {
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

test('默认 body 形状与 schema 冻结值一致', () => {
  assert.deepEqual(readJson('tools/default-body.json'), { primary: 'model', aliases: [] })
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
