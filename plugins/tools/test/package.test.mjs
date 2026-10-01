// `tools` 包形状 / 内容测试（零依赖，node --test）：数据身份，无服务进程。
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
  'build',
  'protocol',
  'restart',
  'health',
  'state',
  'members',
  'commands',
]

test('plugin.json 字段齐全且为数据身份（无 implements / 服务 / pins / needs）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'tools')
  assert.equal(decl.schema, 'schema/tools.json')
  assert.deepEqual(decl.implements, [])
  assert.deepEqual(decl.methods, {})
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, '')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [{ kind: 'schema', path: 'schema/' }])
  assert.deepEqual(decl.commands, [])
  assert.equal(existsSync(join(PKG_ROOT, 'execute')), false, '数据身份不起服务')
})

test('.worldignore 排除 test/ 与 tools/（契约必需文件不可排除）', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.deepEqual(lines, ['test/', 'tools/'])
})

test('schema/tools.json 声明绑定表 body 与绑定声明平铺形状', () => {
  const schema = readJson('schema/tools.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['version', 'bindings'])
  assert.equal(schema.properties.bindings.type, 'object')
  assert.equal(schema.properties.binding.properties.class.type, 'string')
  assert.equal(schema.properties.binding.properties.idempotent.type, 'boolean')
  assert.equal(schema.properties.binding.properties.hidden_params.type, 'array')
})

test('package.json 信封：type=module 与 npm test 脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'tools')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.test, 'node --test')
})

test('红线：schema/ · test/ 不出现宿主 / 内核 / client 引用', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['schema', 'test']) {
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

test('红线：README 不含计划编号样式', () => {
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})
