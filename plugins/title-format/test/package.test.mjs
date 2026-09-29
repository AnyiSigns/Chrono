// `title-format` 包形状 / 内容测试（零依赖，node --test）。
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

test('plugin.json 字段齐全且形态合法；无 needs（无跨身份依赖）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'title-format')
  assert.equal(decl.schema, 'schema/title-format.json')
  assert.deepEqual(decl.implements, ['title-format'])
  assert.deepEqual(decl.methods, {
    'title-format': ['clean', 'fallback', 'resolve'],
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

test('schema/title-format.json 声明三方法入参 / 结果与 method_timeouts', () => {
  const schema = readJson('schema/title-format.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.properties.clean_request.required, ['text', 'max_chars'])
  assert.deepEqual(schema.properties.fallback_request.required, ['first_message', 'max_chars'])
  assert.deepEqual(schema.properties.resolve_request.required, [
    'model_text',
    'first_message',
    'max_chars',
    'title_default',
  ])
  assert.deepEqual(schema.properties.resolve_request.properties.model_text.type, ['string', 'null'])
  assert.deepEqual(schema.properties.title_result.required, ['title'])
  for (const method of ['clean', 'fallback', 'resolve']) {
    assert.ok(schema.method_timeouts[`title-format.${method}`] >= 1)
  }
})

test('execute/ 源码齐全且无 terms/ · 无命令面', () => {
  for (const rel of ['execute/main.ts', 'execute/methods.ts', 'execute/title.ts']) {
    assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  }
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('package.json 零依赖且 test = node --test', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
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
  for (const root of ['execute', 'src', 'terms', 'test']) {
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
