// `memory-consolidate` 包形状 / 声明 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
  'needs',
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

test('plugin.json 13 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'memory-consolidate')
  assert.equal(decl.schema, 'schema/memory-maintenance.json')
  assert.deepEqual(decl.implements, ['memory-maintenance'])
  assert.deepEqual(decl.methods, {
    'memory-maintenance': ['consolidate', 'sweep', 'candidates', 'view', 'edit'],
  })
  assert.deepEqual(decl.needs, {
    compress: { mode: 'one' },
    embedding: { mode: 'one' },
    memory: { mode: 'one' },
    'short-memory': { mode: 'one' },
    session: { mode: 'one' },
  })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('schema：策略参数 + periodic 两拍（只注入派发策略，owner 数据仍由服务自读）', () => {
  const schema = readJson('schema/memory-maintenance.json')
  assert.equal(schema.type, 'object')
  const params = schema.params
  assert.equal(params.l1_ttl_ms, 24 * 60 * 60 * 1000)
  assert.equal(typeof params.l2_capacity, 'number')
  assert.equal(typeof params.l3_capacity, 'number')
  assert.equal(typeof params.dedup_cosine_threshold, 'number')
  assert.equal(typeof params.consolidate_weight_threshold, 'number')
  assert.equal(typeof params.candidate_weight_threshold, 'number')

  assert.ok(Array.isArray(schema.periodic))
  assert.deepEqual(schema.periodic.map((entry) => entry.method), ['consolidate', 'sweep'])
  for (const entry of schema.periodic) {
    assert.equal(typeof entry.every_ms, 'number')
    assert.ok(entry.every_ms > 0)
    // reads 只注入周期派发策略（数据世代 body），不注入 owner 数据。
    assert.equal(typeof entry.reads, 'object')
    assert.ok(Object.keys(entry.reads).length > 0)
    for (const path of Object.values(entry.reads)) {
      assert.ok(Array.isArray(path))
      assert.deepEqual(path.slice(0, 3), ['ids', 'memory-consolidate', 'body'])
    }
  }
  assert.deepEqual(Object.keys(schema.periodic[0].reads), ['summarize'])
  assert.deepEqual(Object.keys(schema.periodic[1].reads).sort(), [
    'candidate_threshold',
    'l1_ttl_ms',
    'l2_capacity',
    'l3_capacity',
  ])
  assert.equal(schema.method_timeouts['memory-maintenance.consolidate'], 4800000)
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('execute/ 源码齐全且不 import 宿主 / 内核 / client / 其他插件包', () => {
  const files = readdirSync(join(PKG_ROOT, 'execute')).filter((name) => name.endsWith('.ts'))
  const expected = [
    'config.ts',
    'log.ts',
    'main.ts',
    'memory.ts',
    'methods.ts',
    'plan.ts',
    'port-link.ts',
    'types.ts',
    'vectors.ts',
    'watermark.ts',
  ]
  assert.deepEqual(files.sort(), expected.sort())
  for (const name of files) {
    const source = readText(join('execute', name))
    assert.equal(/packages\/(host|kernel|client)/.test(source), false, `${name} 不应 import 宿主 / 内核 / client`)
    assert.equal(/from ['"]\.\.\/\.\.\//.test(source), false, `${name} 不应引用包外路径`)
  }
})

test('README / .worldignore / package.json 就位；测试与工具不入世界', () => {
  assert.ok(existsSync(join(PKG_ROOT, 'README.md')))
  const ignore = readText('.worldignore')
  assert.ok(ignore.split(/\r?\n/).includes('test/'))
  assert.ok(ignore.split(/\r?\n/).includes('tools/'))
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'memory-consolidate')
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
