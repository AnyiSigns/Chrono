// 客户端半边入口契约：`entry.tsx` 导出 `contract='2'` 与 `register`，不再导出 `mount`。
// 产物存在时（先经 tools/build-ui.mjs 构建）动态导入产物核对运行期导出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const ENTRY_TSX = join(PKG_ROOT, 'execute', 'web', 'entry.tsx')
const ENTRY_DIST = join(PKG_ROOT, 'execute', 'web', 'dist', 'entry.js')

test('entry.tsx 源码导出 contract=2 与 register，且不再导出 mount', () => {
  const source = readFileSync(ENTRY_TSX, 'utf8')
  assert.match(source, /export const contract = '2'/)
  assert.match(source, /export (async )?function register\(/)
  assert.ok(!/export (async )?function mount\(/.test(source), '不应再导出 mount')
})

test('构建产物导出 contract=2 与 register（无 mount）', async () => {
  if (!existsSync(ENTRY_DIST)) {
    // 未构建（如未跑 tools/build-ui.mjs）时不硬失败：源码断言已覆盖契约。
    return
  }
  const module = await import(pathToFileURL(ENTRY_DIST).href)
  assert.equal(module.contract, '2')
  assert.equal(typeof module.register, 'function')
  assert.equal(module.mount, undefined)
})
