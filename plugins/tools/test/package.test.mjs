// `tools` 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

/** 递归列出目录下全部文件（含子目录）。 */
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else out.push(path)
  }
  return out
}

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
  assert.equal(decl.identity, 'tools')
  assert.equal(decl.schema, 'schema/tools.json')
  assert.deepEqual(decl.implements, ['tools'])
  assert.deepEqual(decl.methods, { tools: ['list', 'dispatch'] })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('pins：工具提供者按各自能力类名，含 evolve-metrics（#44 record 绑定）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.pins, {
    guard: 'guard',
    'tool-fs': 'tool-fs',
    'tool-shell': 'tool-shell',
    'tool-http': 'tool-http',
    'tool-browser': 'tool-browser',
    mcp: 'mcp',
    'plugin-admin': 'plugin-admin',
    'orchestration-admin': 'orchestration-admin',
    'evolve-metrics': 'evolve-metrics',
    todo: 'todo',
    question: 'question',
    session: 'session',
    compress: 'compress',
    memory: 'memory-store',
    retrieval: 'memory-retrieval',
    'memory-maintenance': 'memory-consolidate',
    host: 'host',
  })
  assert.equal(decl.pins['evolve-metrics'], 'evolve-metrics')
})

test('.worldignore 排除 test/ 与 tools/（契约必需文件不可排除）', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.deepEqual(lines, ['test/', 'tools/'])
})

test('schema/tools.json 声明并发上限与结果缓存私有参数', () => {
  const schema = readJson('schema/tools.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.concurrency.type, 'integer')
  assert.equal(schema.properties.concurrency.default, 4)
  assert.equal(schema.properties.cache.properties.enabled.default, true)
  assert.equal(schema.properties.cache.properties.max_entries.default, 256)
  assert.equal(schema.method_timeouts['tools.dispatch'] > 0, true)
  assert.equal(typeof schema.properties.directory, 'object')
  assert.equal(typeof schema.properties.dispatch_result, 'object')
})

test('execute/ 不 import 宿主 / 内核 / client，也不 import 其他插件包', () => {
  const files = readdirSync(join(PKG_ROOT, 'execute')).filter((name) => name.endsWith('.ts'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const text = readText(join('execute', file))
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:'),
        `${file} 不应 import ${specifier}`,
      )
      assert.equal(/packages\/(host|kernel|client)/.test(specifier), false, `${file} 不应 import 宿主 / 内核`)
    }
  }
})

test('package.json 信封：type=module 与 npm test 脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'tools')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.test, 'node --test')
})

test('红线：execute/ · src/ · terms/ · test/ 不出现宿主 / 内核 / client 引用', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['execute', 'src', 'terms', 'test']) {
    const dir = join(PKG_ROOT, root)
    if (!existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      assert.equal(forbidden.test(readFileSync(file, 'utf8')), false, `${file} 出现宿主 / 内核 / client 引用`)
    }
  }
})

test('红线：README 不含计划编号样式', () => {
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})
