// mcp-client 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))



test('schema 声明三方法 / 脱敏 / 超时 / 结构化错误', () => {
  const schema = readJson('schema/mcp-client.json')
  assert.equal(schema.type, 'object')
  assert.ok(schema.properties.list_tools_request)
  assert.ok(schema.properties.call_tool_request)
  assert.ok(schema.properties.close_request)
  assert.deepEqual(schema.properties.client_error.required, ['code', 'message'])
  for (const method of ['list_tools', 'call_tool', 'close']) {
    assert.ok(schema.method_timeouts[`mcp-client.${method}`] > 0)
    assert.ok(Array.isArray(schema.audit_redact[`mcp-client.${method}`]))
  }
})

test('execute/ 源码文件齐全（传输 / 连接表 / 帧循环走 plugin-sdk）', () => {
  for (const rel of [
    'execute/main.ts',
    'execute/methods.ts',
    'execute/registry.ts',
    'execute/connection.ts',
    'execute/events.ts',
    'execute/log.ts',
  ]) {
    assert.ok(existsSync(join(PKG_ROOT, rel)), `缺少 ${rel}`)
  }
  const main = readText('execute/main.ts')
  assert.ok(main.includes("process.on('SIGTERM'"))
  assert.ok(main.includes("process.on('SIGINT'"))
  assert.ok(main.includes('killAllSync'))
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
