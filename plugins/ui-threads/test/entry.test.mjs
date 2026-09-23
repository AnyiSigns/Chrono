// 客户端半边入口契约测试（node --test）：entry.tsx 是 .tsx，Node 不能直接 import，
// 故用 esbuild 擦类型打包（react / jsx-runtime 以桩别名）后 import，验证真实导出形状；
// 并 grep 断言叶子纯模块零 react import（契约要求）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = join(pkgRoot, 'execute', 'web')

test('entry.tsx 导出 contract = "2" 与 register(ctx)，不再导出 mount', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-ui-threads-entry-'))
  try {
    const reactStub = join(root, 'react-stub.js')
    const jsxStub = join(root, 'jsx-runtime-stub.js')
    writeFileSync(
      reactStub,
      'export const useState = (v) => [typeof v === "function" ? v() : v, () => {}]\n' +
        'export const useEffect = () => {}\n' +
        'export const useRef = (v) => ({ current: v })\n' +
        'export const useCallback = (f) => f\n',
    )
    writeFileSync(
      jsxStub,
      'export const jsx = () => null\n' +
        'export const jsxs = () => null\n' +
        'export const Fragment = Symbol("Fragment")\n',
    )
    const outfile = join(root, 'entry.mjs')
    await build({
      entryPoints: [join(webDir, 'entry.tsx')],
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

test('叶子纯模块零 react import（entry.tsx 除外）', () => {
  for (const name of readdirSync(webDir)) {
    if (!/\.(ts|tsx)$/.test(name) || name === 'entry.tsx') continue
    const text = readFileSync(join(webDir, name), 'utf8')
    assert.equal(/from\s+['"]react['"]/.test(text), false, `${name} import 了 react`)
    assert.equal(/from\s+['"]react-dom/.test(text), false, `${name} import 了 react-dom`)
    assert.equal(/from\s+['"]react\//.test(text), false, `${name} import 了 react 子路径`)
    assert.equal(
      /from\s+['"]use-sync-external-store/.test(text),
      false,
      `${name} import 了 use-sync-external-store`,
    )
  }
})
