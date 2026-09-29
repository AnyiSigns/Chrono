// `summarize` 包形状 / 内容测试（零依赖，node --test）。
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

test('plugin.json 字段齐全且形态合法（无 needs：纯函数面）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'summarize')
  assert.equal(decl.schema, 'schema/summarize.json')
  assert.deepEqual(decl.implements, ['summarize'])
  assert.deepEqual(decl.methods, {
    summarize: ['derive', 'parse', 'current', 'sentences', 'merge', 'to_l1', 'to_l2'],
  })
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.needs, undefined)
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.deepEqual(decl.commands, [])
})

test('schema/summarize.json 声明摘要形状与方法入参 / 超时', () => {
  const schema = readJson('schema/summarize.json')
  assert.equal(schema.type, 'object')
  assert.equal(typeof schema.properties.summary, 'object')
  assert.equal(schema.properties.merge_request.properties.outcomes.type, 'object')
  assert.equal(schema.properties.derive_request.properties.target_length.minimum, 1)
  assert.equal(schema.properties.derive_request.properties.extract_items.minimum, 1)
  assert.ok(schema.method_timeouts['summarize.derive'] >= 1000)
  assert.ok(schema.method_timeouts['summarize.merge'] >= 1000)
  assert.equal(schema.periodic, undefined)
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('execute/ 源码齐全', () => {
  const files = ['execute/main.ts', 'execute/methods.ts', 'execute/summary.ts', 'execute/plan.ts']
  for (const rel of files) assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
})

test('package.json 零依赖且 test = node --test', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('.worldignore 只排除 test/，不排除契约必需文件', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
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

test('红线：execute/ · test/ 不出现宿主 / 内核 / client 引用', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['execute', 'test']) {
    const dir = join(PKG_ROOT, root)
    if (!existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      assert.equal(
        forbidden.test(readFileSync(file, 'utf8')),
        false,
        `${file} 出现宿主 / 内核 / client 引用`,
      )
    }
  }
})
