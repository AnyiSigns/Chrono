// `l3-maintenance` 包形状 / 声明 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

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

test('plugin.json 字段齐全且形态合法（needs memory / short-memory / embedding）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'l3-maintenance')
  assert.equal(decl.schema, 'schema/l3-maintenance.json')
  assert.deepEqual(decl.implements, ['l3-maintenance'])
  assert.deepEqual(decl.methods, { 'l3-maintenance': ['solidify', 'forget', 'view', 'edit'] })
  assert.deepEqual(decl.pins, {})
  assert.deepEqual(decl.needs, {
    memory: { mode: 'one' },
    'short-memory': { mode: 'one' },
    embedding: { mode: 'one' },
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

test('schema/l3-maintenance.json 声明入参 / 结果 / 超时', () => {
  const schema = readJson('schema/l3-maintenance.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.params.l3_capacity, 500)
  assert.equal(schema.params.consolidate_weight_threshold, 0.7)
  assert.equal(schema.params.candidate_weight_threshold, 0.2)
  assert.equal(schema.params.solidify_full_sources, 4)
  assert.equal(schema.properties.forget_result.properties.kind.const, 'forget')
  assert.ok(schema.method_timeouts['l3-maintenance.solidify'] > 600000)
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('execute/ 源码齐全', () => {
  for (const name of readdirSync(join(PKG_ROOT, 'execute'))) {
    assert.ok(name.endsWith('.ts'), `${name} 应为 TS 源码`)
  }
  for (const rel of [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/port-link.ts',
    'execute/vectors.ts',
    'execute/plan.ts',
    'execute/memory.ts',
    'execute/config.ts',
    'execute/log.ts',
    'execute/types.ts',
  ]) {
    assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  }
})

test('package.json 零依赖且 test = node --test', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('.worldignore 排除 test/ 与 tools/，不排除契约必需文件', () => {
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

test('红线：execute/ · test/ 不出现宿主 / 内核 / client 引用；README 不含计划编号', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['execute', 'test']) {
    const dir = join(PKG_ROOT, root)
    for (const file of listFiles(dir)) {
      assert.equal(forbidden.test(readFileSync(file, 'utf8')), false, `${file} 出现宿主引用`)
      assert.equal(
        /from ['"]\.\.\/\.\.\//.test(readFileSync(file, 'utf8')),
        false,
        `${file} 引用包外路径`,
      )
    }
  }
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})
