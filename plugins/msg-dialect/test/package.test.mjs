// `msg-dialect` 包形状 / 内容测试（零依赖，node --test）。
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

test('plugin.json 字段齐全；pins host（资产内联），无 needs', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'msg-dialect')
  assert.equal(decl.schema, 'schema/msg-dialect.json')
  assert.deepEqual(decl.implements, ['msg-dialect'])
  assert.deepEqual(decl.methods, {
    'msg-dialect': [
      'normalize-quirks',
      'reasoning-capability',
      'encode-tools',
      'apply-auth',
      'build',
      'parse-full',
      'inline-assets',
    ],
  })
  assert.deepEqual(decl.pins, { host: 'host' })
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

test('schema 声明 audit_redact / method_timeouts', () => {
  const schema = readJson('schema/msg-dialect.json')
  assert.equal(schema.type, 'object')
  for (const method of [
    'normalize-quirks',
    'reasoning-capability',
    'encode-tools',
    'apply-auth',
    'build',
    'parse-full',
    'inline-assets',
  ]) {
    assert.ok(
      Array.isArray(schema.audit_redact[`msg-dialect.${method}`]),
      `缺 audit_redact ${method}`,
    )
    assert.ok(schema.method_timeouts[`msg-dialect.${method}`] >= 1, `缺 method_timeouts ${method}`)
  }
})

test('execute 源码齐全', () => {
  for (const rel of [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/dialect.ts',
    'execute/quirks.ts',
    'execute/reasoning.ts',
    'execute/assets.ts',
  ]) {
    assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  }
})

test('package.json 零依赖且 test = node --test', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('.worldignore 声明 test/，不排除契约必需文件', () => {
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
