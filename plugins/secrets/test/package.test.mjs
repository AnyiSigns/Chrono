// secrets 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))



test('schema/secrets.json 声明 auth_ref（kind 开放词表）与失败码', () => {
  const schema = readJson('schema/secrets.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.auth_ref.properties.kind.type, 'string')
  assert.equal(schema.properties.auth_ref.properties.kind.enum, undefined)
  assert.deepEqual(schema.properties.auth_ref.required, ['kind', 'name'])
  assert.deepEqual(schema.properties.list_entry.required, ['name', 'has'])
  assert.ok(schema.properties.errors.properties.secret_kind_unsupported)
  assert.ok(schema.properties.errors.properties.secret_kind_ambiguous)
})

test('execute/ 源码文件齐全（帧编解码 / 帧循环走 plugin-sdk）', () => {
  for (const rel of [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/port-link.ts',
    'execute/types.ts',
  ]) {
    assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  }
  assert.equal(
    existsSync(join(PKG_ROOT, 'execute/secrets-file.ts')),
    false,
    'secrets-file.ts 应已迁入 secrets-local',
  )
})

test('package.json 零依赖且带测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('.worldignore 声明 test/ 与 tools/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
