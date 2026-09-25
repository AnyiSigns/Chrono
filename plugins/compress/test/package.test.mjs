// `compress` 包形状 / 内容测试（零依赖，node --test）。
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
  assert.equal(decl.identity, 'compress')
  assert.equal(decl.schema, 'schema/compress.json')
  assert.deepEqual(decl.implements, ['compress'])
  assert.deepEqual(decl.methods, { compress: ['summarize', 'compact', 'extract'] })
  assert.deepEqual(decl.pins, { model: 'model-protocol', embedding: 'embedding', 'short-memory': 'short-memory' })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
  assert.equal(decl.health.probe, 'compress.summarize')
})

test('schema/compress.json 声明 mode / 目标长度 / 去重阈值 / 抽取条数（钳制 2..3）', () => {
  const schema = readJson('schema/compress.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.properties.mode.enum, ['algorithmic', 'semantic'])
  assert.equal(schema.properties.target_length.type, 'integer')
  assert.equal(schema.properties.target_length.default, 280)
  assert.equal(schema.properties.dedup_threshold.type, 'number')
  assert.equal(schema.properties.extract_items.type, 'integer')
  assert.equal(schema.properties.extract_items.minimum, 1)
  assert.equal(schema.properties.extract_items.maximum, undefined)
  assert.equal(schema.properties.embedding_model.default, 'granite-97m')
  assert.equal(typeof schema.properties.l1_summary, 'object')
  assert.equal(typeof schema.properties.summarize_request, 'object')
  assert.equal(typeof schema.properties.compact_request, 'object')
  assert.equal(typeof schema.properties.extract_request, 'object')
  // 达阈触发阈值不住本 schema（触发判定归上下文调配器）
  assert.equal(schema.periodic, undefined)
  assert.ok(schema.method_timeouts['compress.summarize'] >= 60000)
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('execute/ 源码齐全', () => {
  const files = [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/summary.ts',
    'execute/semantic.ts',
    'execute/dedup.ts',
    'execute/port-link.ts',
    'execute/plan.ts',
    'execute/plugin.ts',
    'execute/frames.ts',
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

test('.worldignore 声明 test/ 与 tools/，不排除契约必需文件', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
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
