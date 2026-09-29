// mcp 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

test('plugin.json：身份 / 方法面不变，needs 增 mcp-client、保留 secrets', () => {
  const decl = readJson('plugin.json')
  assert.equal(decl.identity, 'mcp')
  assert.deepEqual(decl.implements, ['mcp', 'tool-provider'])
  assert.deepEqual(decl.methods, {
    mcp: ['describe', 'invoke', 'discover', 'read', 'write'],
    'tool-provider': ['describe', 'invoke'],
  })
  assert.deepEqual(decl.pins, {})
  assert.deepEqual(decl.needs, { secrets: { mode: 'one' }, 'mcp-client': { mode: 'one' } })
  assert.equal(decl.state, 'durable')
  assert.deepEqual(decl.exclusive, ['data'])
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
    { kind: 'schema', path: 'schema/' },
  ])
})

test('出站连接 / 子进程生命周期已移出：无 mcp-client.ts，改为 port-link 委派', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'execute', 'mcp-client.ts')), false)
  const registry = readText('execute/registry.ts')
  assert.ok(!registry.includes('McpConnection'))
  assert.ok(registry.includes("from './port-link.ts'"))
  const main = readText('execute/main.ts')
  assert.ok(!main.includes('SIGTERM'), '子进程信号兜底应归 mcp-client')
  assert.ok(main.includes('PortLink'))
})

test('schema：discover 超时严格大于 mcp-client.list_tools 声明超时', () => {
  const schema = readJson('schema/mcp.json')
  const clientSchema = JSON.parse(readText(join('..', 'mcp-client', 'schema', 'mcp-client.json')))
  assert.equal(schema.method_timeouts['mcp.discover'], 60000)
  assert.ok(
    schema.method_timeouts['mcp.discover'] > clientSchema.method_timeouts['mcp-client.list_tools'],
  )
})

test('package.json 零依赖且带测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
