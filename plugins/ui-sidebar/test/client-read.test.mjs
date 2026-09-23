// 客户端半边只读命令 `ui-sidebar.client.read`：路径穿越防护与正常读回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLIENT_WEB_DIR, clientRelPath, isSafeClientPath, readClientFile } from '../execute/client-files.js'
import { createHandlers } from '../execute/methods.js'
import { BadArgsError } from '../execute/types.js'

test('路径形态：只接受包内相对 .js，拒绝绝对 / 盘符 / 反斜杠 / .. / 空段 / 非 .js', () => {
  assert.equal(isSafeClientPath('dist/entry.js'), true)
  assert.equal(isSafeClientPath('entry.js'), true)
  assert.equal(isSafeClientPath('a/b/c.js'), true)

  assert.equal(isSafeClientPath(''), false)
  assert.equal(isSafeClientPath('../plugin.json'), false)
  assert.equal(isSafeClientPath('a/../../b.js'), false)
  assert.equal(isSafeClientPath('/etc/passwd.js'), false)
  assert.equal(isSafeClientPath('C:/x.js'), false)
  assert.equal(isSafeClientPath('c:dist/entry.js'), false)
  assert.equal(isSafeClientPath('a\\b.js'), false)
  assert.equal(isSafeClientPath('a//b.js'), false)
  assert.equal(isSafeClientPath('a/./b.js'), false)
  assert.equal(isSafeClientPath('dist/entry.js/..'), false)
  assert.equal(isSafeClientPath('dist/entry.txt'), false)
  assert.equal(isSafeClientPath('dist/entry.js\u0000'), false)
  assert.equal(isSafeClientPath(42), false)
  assert.equal(isSafeClientPath(null), false)
})

test('前缀归一：dist/ 与 execute/web/、web/ 前缀都落到客户端半边根', () => {
  assert.equal(clientRelPath('dist/entry.js'), 'dist/entry.js')
  assert.equal(clientRelPath('execute/web/dist/entry.js'), 'dist/entry.js')
  assert.equal(clientRelPath('web/dist/entry.js'), 'dist/entry.js')
})

test('正常读回与结构化失败（临时目录，确定性）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrono-ui-sidebar-client-'))
  try {
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'entry.js'), 'export const contract = "2"\n', 'utf8')
    writeFileSync(join(dir, 'plain.js'), 'x\n', 'utf8')

    const ok = readClientFile(dir, 'dist/entry.js')
    assert.equal(ok.ok, true)
    assert.equal(ok.path, 'dist/entry.js')
    assert.match(ok.text, /contract = "2"/)
    assert.equal(readClientFile(dir, 'execute/web/dist/entry.js').text, ok.text)
    assert.equal(readClientFile(dir, 'plain.js').ok, true)

    assert.deepEqual(readClientFile(dir, '../plugin.json'), { ok: false, code: 'bad_path' })
    assert.deepEqual(readClientFile(dir, '/abs.js'), { ok: false, code: 'bad_path' })
    assert.deepEqual(readClientFile(dir, 'C:/x.js'), { ok: false, code: 'bad_path' })
    assert.deepEqual(readClientFile(dir, 'a\\b.js'), { ok: false, code: 'bad_path' })
    assert.deepEqual(readClientFile(dir, 'dist/nope.js'), { ok: false, code: 'not_found' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handler：缺 path / 穿越路径抛 BadArgsError；正常路径回 {path,text}', () => {
  const handlers = createHandlers({
    identity: 'ui-sidebar',
    session: { call: async () => ({ ok: false, code: 'x', message: '' }) },
    workspace: { call: async () => ({ ok: false, code: 'x', message: '' }) },
  })
  assert.throws(() => handlers.clientRead(null), BadArgsError)
  assert.throws(() => handlers.clientRead({}), BadArgsError)
  assert.throws(() => handlers.clientRead({ path: 42 }), BadArgsError)
  assert.throws(() => handlers.clientRead({ path: '../plugin.json' }), BadArgsError)
  assert.throws(() => handlers.clientRead({ path: '/etc/passwd.js' }), BadArgsError)
  assert.throws(() => handlers.clientRead({ path: 'C:/x.js' }), BadArgsError)
  assert.throws(() => handlers.clientRead({ path: 'a\\b.js' }), BadArgsError)

  assert.ok(CLIENT_WEB_DIR.replace(/[\\/]+$/, '').endsWith(join('execute', 'web')))
  const built = join(CLIENT_WEB_DIR, 'dist', 'entry.js')
  if (existsSync(built)) {
    const value = handlers.clientRead({ path: 'dist/entry.js' })
    assert.equal(value.path, 'dist/entry.js')
    assert.equal(typeof value.text, 'string')
    assert.ok(value.text.length > 0)
  }
})
