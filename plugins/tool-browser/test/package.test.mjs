// 包形状 / 内容测试：plugin.json 12 字段、schema 配置、.worldignore、execute 源码、零依赖、README。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ERROR_CODES } from '../execute/types.ts'

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
  assert.equal(decl.identity, 'tool-browser')
  assert.equal(decl.schema, 'schema/tool-browser.json')
  assert.deepEqual(decl.implements, ['tool-browser'])
  assert.deepEqual(decl.methods, { 'tool-browser': ['describe', 'invoke'] })
  assert.deepEqual(decl.pins, { sandbox: 'sandbox', host: 'host' })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('无 terms 目录 / 无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false)
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('schema/tool-browser.json 声明引擎 / 视口 / 超时 / 截图 / 下载', () => {
  const schema = readJson('schema/tool-browser.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.properties.engine.properties.impl.enum, ['playwright', 'cdp'])
  assert.equal(typeof schema.properties.engine.properties.headless.default, 'boolean')
  assert.equal(typeof schema.properties.viewport.properties.width.default, 'number')
  assert.equal(typeof schema.properties.timeouts.properties.session_idle_ms.default, 'number')
  assert.deepEqual(schema.properties.screenshot.properties.format.enum, ['png', 'jpeg'])
  assert.equal(typeof schema.properties.download.properties.allow.default, 'boolean')
  assert.equal(typeof schema.method_timeouts['tool-browser.invoke'], 'number')
})

test('schema：tier 用 JSON null（nullable 语义，非字符串 "null"）；不声明 grant', () => {
  const schema = readJson('schema/tool-browser.json')
  const tierEnum = schema.properties.invoke_bag.properties.tier.enum
  assert.deepEqual(tierEnum, ['auto', 'severe', 'review', 'deny', null])
  assert.ok(!tierEnum.includes('null'), 'tier 枚举不应含字符串 "null"')
  assert.equal(schema.properties.invoke_bag.properties.grant, undefined, '浏览器不经 sandbox.exec，不声明 grant')
})

test('schema error.code 闭集与 ERROR_CODES 一致', () => {
  const schema = readJson('schema/tool-browser.json')
  const codes = schema.properties.invoke_result.properties.error.properties.code.enum
  assert.deepEqual(codes, [...ERROR_CODES])
})

test('execute 源码齐全', () => {
  const files = [
    'execute/main.ts',
    'execute/frames.ts',
    'execute/types.ts',
    'execute/plugin.ts',
    'execute/config.ts',
    'execute/state-dir.ts',
    'execute/link.ts',
    'execute/lifecycle.ts',
    'execute/creation.ts',
    'execute/net.ts',
    'execute/sessions.ts',
    'execute/describe.ts',
    'execute/invoke.ts',
    'execute/engine/types.ts',
    'execute/engine/factory.ts',
    'execute/engine/playwright.ts',
    'execute/engine/cdp.ts',
    'execute/engine/cdp-connection.ts',
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
