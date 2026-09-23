// `client.read` 只读命令测试（node --test）：路径穿越防护 + 正常读回 + 方法表接线。
// 客户端半边产物被 `.worldignore` 排除，壳经本命令取字节；故防护必须是 fail-closed。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHandlers, isSafeClientPath, readClientFile } from '../execute/methods.ts'

const ENV = { run: null, thread: null, now: 0 }

function tempWeb() {
  const root = mkdtempSync(join(tmpdir(), 'chrono-ui-threads-web-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'entry.js'), 'export const built = true\n')
  return root
}

test('isSafeClientPath：只接受包内相对 .js，拒绝绝对 / 盘符 / 反斜杠 / .. / 空段 / 非 js', () => {
  assert.equal(isSafeClientPath('dist/entry.js'), true)
  assert.equal(isSafeClientPath('a/b/c.js'), true)
  assert.equal(isSafeClientPath('/etc/passwd'), false)
  assert.equal(isSafeClientPath('/abs.js'), false)
  assert.equal(isSafeClientPath('C:/x.js'), false)
  assert.equal(isSafeClientPath('C:\\x.js'), false)
  assert.equal(isSafeClientPath('a\\b.js'), false)
  assert.equal(isSafeClientPath('../secret.js'), false)
  assert.equal(isSafeClientPath('a/../../b.js'), false)
  assert.equal(isSafeClientPath('a//b.js'), false)
  assert.equal(isSafeClientPath('./a.js'), false)
  assert.equal(isSafeClientPath('a/./b.js'), false)
  assert.equal(isSafeClientPath(''), false)
  assert.equal(isSafeClientPath('plugin.json'), false)
  assert.equal(isSafeClientPath('dist/entry.ts'), false)
  assert.equal(isSafeClientPath(null), false)
  assert.equal(isSafeClientPath(42), false)
  assert.equal(isSafeClientPath(['dist/entry.js']), false)
})

test('readClientFile：正常读回 {path,text}，穿越 / 越界 / 缺失拒绝', () => {
  const webRoot = tempWeb()
  try {
    assert.deepEqual(readClientFile(webRoot, 'dist/entry.js'), {
      path: 'dist/entry.js',
      text: 'export const built = true\n',
    })
    assert.equal(readClientFile(webRoot, '../plugin.json'), null)
    assert.equal(readClientFile(webRoot, '/etc/passwd'), null)
    assert.equal(readClientFile(webRoot, 'dist/missing.js'), null)
    assert.equal(readClientFile(webRoot, 'dist'), null)
  } finally {
    rmSync(webRoot, { recursive: true, force: true })
  }
})

test('client.read 方法：{path} → {path,text}；非法路径抛错（fail-closed）', () => {
  const webRoot = tempWeb()
  try {
    const handlers = createHandlers({ identity: 'ui-threads', webRoot })
    const value = handlers['client.read']({ path: 'dist/entry.js' }, ENV).value
    assert.equal(value.path, 'dist/entry.js')
    assert.equal(value.text, 'export const built = true\n')
    assert.throws(() => handlers['client.read']({ path: '../plugin.json' }, ENV))
    assert.throws(() => handlers['client.read']({ path: '/abs.js' }, ENV))
    assert.throws(() => handlers['client.read']({ path: 'dist/missing.js' }, ENV))
    assert.throws(() => handlers['client.read'](null, ENV))
  } finally {
    rmSync(webRoot, { recursive: true, force: true })
  }
})
