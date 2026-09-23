// 壳 vendor 运行时构建：把 React 运行时打成本地 ESM 产物，供 shell.html 的 import map 唯一映射。
// 只在构建期跑一次；插件客户端半边用裸 specifier import，浏览器按 import map 解析，React 全站一份。
//
// 产物落 `plugins/ui-shell/execute/web/vendor/vendor.js`（随壳包入世、由壳以 /assets/vendor/* 同源服务）。
//
// 为什么是「单产物 + 显式具名导出包装」：
// 1) React 19 的 npm 包只发 CJS，esbuild 无法从压缩后的 CJS 静态推断具名导出（直接以包为 entry
//    只会得到 `export default`，浏览器里 `import { Component } from 'react'` 即报错）。故在构建期
//    require 各包、枚举运行时导出键，生成 `export const X = ns.X` 的 ESM 包装作为 entry。
// 2) react-dom / use-sync-external-store 内部 `require("react")`。若各自单独打包，会内联出第二份
//    React，hooks 读到的 dispatcher 与 react-dom 设置的不是同一份（`Cannot read properties of null
//    (reading 'useRef')`）。把它们与 react 打进**同一产物**，esbuild 去重为同一模块实例；import map
//    再把 react / react-dom / react-dom/client / react/jsx-runtime / use-sync-external-store 全部
//    指向该产物，保证全站一份 React。

import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'plugins', 'ui-shell', 'execute', 'web', 'vendor')
const tmpDir = join(root, 'node_modules', '.chrono-build')

/** 产物名；import map 的全部运行时 specifier 都映射到它。 */
export const VENDOR_FILE = 'vendor.js'

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 需要并入同一实例的运行时入口：默认导出取首个（react），具名导出跨包去重。 */
const SOURCES = [
  { varName: '__react', specifier: 'react' },
  { varName: '__jsx', specifier: 'react/jsx-runtime' },
  { varName: '__dom', specifier: 'react-dom' },
  { varName: '__client', specifier: 'react-dom/client' },
  { varName: '__store', specifier: 'use-sync-external-store/shim' },
]

/** 生成 ESM 包装 entry：默认导出 react，并把各包运行时键逐一具名导出（跨包去重）。 */
function wrapperSource(sources) {
  const lines = sources.map(({ varName, specifier }) => `import ${varName} from ${JSON.stringify(specifier)}`)
  lines.push(`export default ${sources[0].varName}`)
  const seen = new Set(['default'])
  for (const { varName, specifier } of sources) {
    for (const name of Object.keys(require(specifier))) {
      if (seen.has(name) || !IDENT.test(name)) continue
      seen.add(name)
      lines.push(`export const ${name} = ${varName}[${JSON.stringify(name)}]`)
    }
  }
  return lines.join('\n') + '\n'
}

async function main() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })

  const entry = join(tmpDir, `vendor-${VENDOR_FILE}`)
  writeFileSync(entry, wrapperSource(SOURCES), 'utf8')
  await build({
    entryPoints: [entry],
    outfile: join(outDir, VENDOR_FILE),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  })
  process.stdout.write(`vendor: ${VENDOR_FILE}\n`)
  process.stdout.write(`vendor runtime → ${dirname(outDir)}\n`)
}

main().catch((err) => {
  process.stderr.write(`build-vendor failed: ${String(err && err.message ? err.message : err)}\n`)
  process.exitCode = 1
})
