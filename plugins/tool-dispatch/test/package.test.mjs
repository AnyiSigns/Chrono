// `tool-dispatch` 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  'concurrent_methods',
  'pins',
  'needs',
  'start',
  'build',
  'protocol',
  'restart',
  'health',
  'state',
  'members',
  'commands',
]

test('plugin.json 15 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'tool-dispatch')
  assert.equal(decl.schema, 'schema/tool-dispatch.json')
  assert.deepEqual(decl.implements, ['tool-dispatch'])
  assert.deepEqual(decl.methods, { 'tool-dispatch': ['dispatch'] })
  assert.deepEqual(decl.concurrent_methods, ['dispatch'])
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('needs：tool-registry + tool-schema + guard + tool-provider(many) + 绑定提供者类逐个 one', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.needs, {
    'tool-registry': { mode: 'one' },
    'tool-schema': { mode: 'one' },
    guard: { mode: 'one' },
    'tool-provider': { mode: 'many' },
    session: { mode: 'one' },
    compress: { mode: 'one' },
    memory: { mode: 'one' },
    retrieval: { mode: 'one' },
    'memory-maintenance': { mode: 'one' },
    'evolve-metrics': { mode: 'one' },
  })
})

test('schema/tool-dispatch.json 声明并发 / 缓存私有参数与超时（严格小于门面）', () => {
  const schema = readJson('schema/tool-dispatch.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.concurrency.default, 4)
  assert.equal(schema.properties.cache.properties.enabled.default, true)
  assert.equal(schema.properties.dispatch_result.type, 'object')
  const toolDispatch = schema.method_timeouts['tool-dispatch.dispatch']
  const facade = readJson('../tools/schema/tools.json').method_timeouts['tools.dispatch']
  assert.ok(toolDispatch > 0 && toolDispatch < facade, '多一跳须严格嵌套超时')
  assert.ok(Array.isArray(schema.audit_redact['tool-dispatch.dispatch']))
})

test('execute/ 源码文件齐全（帧编解码 / 帧循环走 plugin-sdk）', () => {
  for (const rel of [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/dispatch.ts',
    'execute/port-link.ts',
    'execute/cache.ts',
    'execute/config.ts',
    'execute/types.ts',
  ]) {
    assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  }
})

test('execute/ 不 import 宿主 / 内核 / client，也不 import 其他插件包', () => {
  const dir = join(PKG_ROOT, 'execute')
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    for (const specifier of importsOf(readText(join('execute', file)))) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('node:') || specifier === 'plugin-sdk',
        `${file} 不应 import ${specifier}`,
      )
      assert.equal(
        /packages\/(host|kernel|client)/.test(specifier),
        false,
        `${file} 不应 import 宿主 / 内核`,
      )
    }
  }
})

test('package.json 零依赖且带测试脚本；.worldignore 只声明 test/', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'tool-dispatch')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.deepEqual(lines, ['test/'])
})

test('README 不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans') && !/-plan\.md/.test(readme), 'README 引用了计划文档')
})

function importsOf(text) {
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
}
