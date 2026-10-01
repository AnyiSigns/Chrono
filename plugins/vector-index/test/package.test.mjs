// `vector-index` 包形状 / 声明 / 内容测试（零依赖，node --test）。
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


test('schema/vector-index.json：方法入参 / 结果形状与超时 / 审计面', () => {
  const schema = readJson('schema/vector-index.json')
  assert.equal(schema.type, 'object')
  const props = schema.properties
  assert.equal(typeof props.upsert_request, 'object')
  assert.equal(typeof props.upsert_result, 'object')
  assert.equal(typeof props.remove_request, 'object')
  assert.equal(typeof props.search_request, 'object')
  assert.equal(typeof props.search_result, 'object')
  assert.equal(typeof props.info_result, 'object')
  assert.deepEqual(props.upsert_request.required, ['model', 'dim', 'count', 'records'])
  assert.equal(props.search_request.required[0], 'query_vector')
  assert.equal(props.upsert_result.properties.present.const, true)
  assert.equal(typeof schema.method_timeouts['vector-index.upsert'], 'number')
  assert.equal(typeof schema.method_timeouts['vector-index.search'], 'number')
  assert.deepEqual(schema.audit_redact['vector-index.search'], [])
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
  assert.deepEqual(readJson('plugin.json').commands, [])
})

test('execute/ 源码齐全且不 import 宿主 / 内核 / client / 其他插件包', () => {
  const files = readdirSync(join(PKG_ROOT, 'execute')).filter((name) => name.endsWith('.ts'))
  assert.deepEqual(files.sort(), ['heap.ts', 'main.ts', 'methods.ts', 'vector-index.ts'])
  for (const name of files) {
    const source = readText(join('execute', name))
    assert.equal(
      /packages\/(host|kernel|client)/.test(source),
      false,
      `${name} 不应 import 宿主 / 内核 / client`,
    )
    assert.equal(/from ['"]\.\.\/\.\.\//.test(source), false, `${name} 不应引用包外路径`)
  }
})

test('README / .worldignore / package.json 就位；测试与工具不入世界', () => {
  assert.ok(existsSync(join(PKG_ROOT, 'README.md')))
  const ignore = readText('.worldignore')
  assert.ok(ignore.split(/\r?\n/).includes('test/'))
  assert.ok(ignore.split(/\r?\n/).includes('tools/'))
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'vector-index')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.test, 'node --test')
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

test('红线：README 不含计划编号样式', () => {
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})
