// 客户端半边交付契约测试（node --test）：
// `ui-composer.client.read` 路径穿越防护与正常读回；entry.tsx 导出 contract / register；叶子模块零 react。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { isSafeClientPath, readClientFile, resolveClientPath } from '../execute/client-read.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(resolve(HERE, '..'), 'execute', 'web')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-composer-${label}-`))
}

test('client.read：只接受包内相对 .js，拒绝绝对 / 盘符 / 反斜杠 / .. / 空段', () => {
  assert.equal(isSafeClientPath('dist/entry.js'), true)
  assert.equal(isSafeClientPath('entry.js'), true)
  assert.equal(isSafeClientPath('/etc/passwd.js'), false)
  assert.equal(isSafeClientPath('C:/x.js'), false)
  assert.equal(isSafeClientPath('c:\\x.js'), false)
  assert.equal(isSafeClientPath('..\\x.js'), false)
  assert.equal(isSafeClientPath('../plugin.json'), false)
  assert.equal(isSafeClientPath('dist/../../x.js'), false)
  assert.equal(isSafeClientPath('dist//x.js'), false)
  assert.equal(isSafeClientPath('./x.js'), false)
  assert.equal(isSafeClientPath('dist/x.ts'), false)
  assert.equal(isSafeClientPath(''), false)
  assert.equal(isSafeClientPath(null), false)
  assert.equal(isSafeClientPath(7), false)
})

test('client.read：正常读回包内文件，越界与缺失返回 null', () => {
  const dir = tempDir('client-read')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'entry.js'), 'export const ok = 1\n', 'utf8')
  assert.equal(readClientFile(dir, 'dist/entry.js'), 'export const ok = 1\n')
  assert.equal(readClientFile(dir, '../secret.js'), null)
  assert.equal(readClientFile(dir, 'dist/nope.js'), null)
  assert.equal(resolveClientPath(dir, 'dist/entry.js'), join(dir, 'dist', 'entry.js'))
  rmSync(dir, { recursive: true, force: true })
})

test('entry.tsx 导出 contract=2 / register，且不再导出 mount', () => {
  const source = readFileSync(join(WEB, 'entry.tsx'), 'utf8')
  assert.match(source, /export const contract = '2'/)
  assert.match(source, /export function register\(ctx: SlotContext\)/)
  assert.equal(/export (async )?function mount\b/.test(source), false)
})

test('叶子纯模块零 react import', () => {
  for (const name of ['model.ts', 'attach.ts', 'dropdown.ts', 'messages.ts', 'run-model.ts']) {
    const source = readFileSync(join(WEB, name), 'utf8')
    assert.equal(/from\s+['"]react/.test(source), false, `${name} import 了 react`)
  }
})
