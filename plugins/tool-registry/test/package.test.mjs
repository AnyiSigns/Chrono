// `tool-registry` 包形状 / 内容测试（零依赖，node --test）。
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
  'pins',
  'slots',
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
  assert.equal(decl.identity, 'tool-registry')
  assert.equal(decl.schema, 'schema/tool-registry.json')
  assert.deepEqual(decl.implements, ['tool-registry'])
  assert.deepEqual(decl.methods, { 'tool-registry': ['list'] })
  assert.deepEqual(decl.pins, {})
  assert.deepEqual(decl.slots, { 'tool-provider': { methods: ['describe', 'invoke'] } })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('needs：tool-provider 为 many 扩展类；tool-schema + 绑定提供者类逐个 one', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.needs, {
    'tool-provider': { mode: 'many' },
    'tool-schema': { mode: 'one' },
    session: { mode: 'one' },
    compress: { mode: 'one' },
    memory: { mode: 'one' },
    retrieval: { mode: 'one' },
    'memory-maintenance': { mode: 'one' },
    'evolve-metrics': { mode: 'one' },
  })
})

test('schema/tool-registry.json 声明 list 请求 / 结果 / 超时', () => {
  const schema = readJson('schema/tool-registry.json')
  assert.equal(schema.type, 'object')
  assert.ok(schema.properties.list_request)
  assert.ok(schema.properties.directory)
  assert.ok(schema.method_timeouts['tool-registry.list'] > 0)
  assert.ok(Array.isArray(schema.audit_redact['tool-registry.list']))
})

test('execute/ 源码文件齐全（帧编解码 / 帧循环走 plugin-sdk）', () => {
  for (const rel of [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/directory.ts',
    'execute/port-link.ts',
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
  assert.equal(pkg.name, 'tool-registry')
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
