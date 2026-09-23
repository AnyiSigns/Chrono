// 客户端半边契约测试：client.read 路径穿越防护与正常读回、entry.tsx 导出 contract / register。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { createHandlers, isSafeClientPath, readClientFile } from '../execute/methods.ts'
import { BadArgsError } from '../execute/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const ENV = { run: null, thread: null, now: 0 }

function fakeApproval() {
  return { call: async () => ({ ok: true, value: { $directives: [] } }) }
}

test('isSafeClientPath：只放行包内相对 .js，拒绝穿越 / 绝对 / 盘符 / 反斜杠 / 空段', () => {
  for (const ok of ['dist/entry.js', 'entry.js', 'a/b/c.js']) {
    assert.equal(isSafeClientPath(ok), true, ok)
  }
  const bad = [
    '',
    '/etc/passwd.js',
    'C:/x.js',
    'c:\\x.js',
    '..\\x.js',
    '../plugin.json',
    'a/../b.js',
    'a/./b.js',
    'a//b.js',
    './x.js',
    'dist/entry',
    'dist/entry.txt',
    'dist\\entry.js',
    null,
    42,
    undefined,
    {},
  ]
  for (const value of bad) {
    assert.equal(isSafeClientPath(value), false, String(value))
  }
})

test('readClientFile：包内相对 .js 可读回；穿越 / 不存在回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-ui-approval-client-'))
  try {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'entry.js'), 'export const ok = 1\n')
    assert.deepEqual(readClientFile(root, 'dist/entry.js'), {
      path: 'dist/entry.js',
      text: 'export const ok = 1\n',
    })
    assert.equal(readClientFile(root, '../outside.js'), null)
    assert.equal(readClientFile(root, 'dist/missing.js'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('client.read 方法：正常读回 {path,text}，穿越 / 缺参结构化 bad_args', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-ui-approval-read-'))
  try {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'entry.js'), 'export const contract = "2"\n')
    const handlers = createHandlers({ identity: 'ui-approval', approval: fakeApproval(), webRoot: root })
    assert.deepEqual(await handlers['client.read']({ path: 'dist/entry.js' }, ENV), {
      path: 'dist/entry.js',
      text: 'export const contract = "2"\n',
    })
    assert.throws(() => handlers['client.read']({ path: '../plugin.json' }, ENV), BadArgsError)
    assert.throws(() => handlers['client.read']({ path: 'C:/x.js' }, ENV), BadArgsError)
    assert.throws(() => handlers['client.read']({}, ENV), BadArgsError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('entry.tsx 导出 contract="2" 与 register（esbuild 擦类型 + 别名桩 react）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-ui-approval-entry-'))
  try {
    const reactStub = join(root, 'react-stub.js')
    const jsxStub = join(root, 'jsx-runtime-stub.js')
    writeFileSync(
      reactStub,
      'export const useState = (v) => [v, () => {}]\n' +
        'export const useEffect = () => {}\n' +
        'export const useRef = () => ({ current: null })\n' +
        'export const useMemo = (f) => f()\n' +
        'export const createElement = () => null\n',
    )
    writeFileSync(
      jsxStub,
      'export const jsx = () => null\n' +
        'export const jsxs = () => null\n' +
        'export const Fragment = Symbol("Fragment")\n',
    )
    const outfile = join(root, 'entry.mjs')
    await build({
      entryPoints: [join(PKG_ROOT, 'execute', 'web', 'entry.tsx')],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      jsx: 'automatic',
      alias: { react: reactStub, 'react/jsx-runtime': jsxStub },
      logLevel: 'silent',
    })
    const module = await import(pathToFileURL(outfile).href)
    assert.equal(module.contract, '2')
    assert.equal(typeof module.register, 'function')
    assert.equal(module.mount, undefined, '客户端半边不再导出 mount')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
