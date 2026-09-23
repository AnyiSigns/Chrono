// 壳 vendor 运行时构建：把 React 运行时打成本地 ESM 产物，供 shell.html 的 import map 唯一映射。
// 只在构建期跑一次；插件客户端半边用裸 specifier import，浏览器按 import map 解析，React 全站一份。
//
// 产物落 `plugins/ui-shell/execute/web/vendor/`（随壳包入世、由壳以 /assets/vendor/* 同源服务）。
// 说明：react-dom 与 react-dom/client 合并到同一产物（映射到同一 URL），避免 internals 重复打包；
// react/jsx-runtime 单独一份（与 react 有 Fragment 同名导出，不能合并）。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'plugins', 'ui-shell', 'execute', 'web', 'vendor')
const tmpDir = join(root, 'node_modules', '.chrono-build')

const REACT_DOM_MERGED_ENTRY = [
  "export * from 'react-dom'",
  "export { createRoot, hydrateRoot } from 'react-dom/client'",
  '',
].join('\n')

/** 一个 vendor 产物：entry 文件 → outfile；external 之外全部内联。 */
const TARGETS = [
  { name: 'react', entry: 'react', out: 'react.js' },
  { name: 'react-jsx-runtime', entry: 'react/jsx-runtime', out: 'react-jsx-runtime.js' },
  { name: 'react-dom', entry: '@chrono/react-dom-entry', out: 'react-dom.js' },
  {
    name: 'use-sync-external-store',
    entry: 'use-sync-external-store/shim',
    out: 'use-sync-external-store.js',
  },
]

async function main() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  const mergedEntry = join(tmpDir, 'react-dom-entry.js')
  writeFileSync(mergedEntry, REACT_DOM_MERGED_ENTRY, 'utf8')

  for (const target of TARGETS) {
    const entry = target.entry.startsWith('@chrono/') ? mergedEntry : target.entry
    await build({
      entryPoints: [entry],
      outfile: join(outDir, target.out),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      logLevel: 'warning',
    })
    process.stdout.write(`vendor: ${target.out}\n`)
  }
  process.stdout.write(`vendor runtime → ${dirname(outDir)}\n`)
}

main().catch((err) => {
  process.stderr.write(`build-vendor failed: ${String(err && err.message ? err.message : err)}\n`)
  process.exitCode = 1
})
