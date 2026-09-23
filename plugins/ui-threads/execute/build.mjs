// 构建 ui-threads 客户端半边：esbuild JS API 打包 `execute/web/entry.tsx` → `execute/web/dist/entry.js`。
// 用 JS API 而非 CLI：esbuild CLI 的字符串选项必须写 `--opt=value`，而 `plugin.json.build` 的 args
// 白名单不允许 `=`。产物 externalize 壳 vendor（壳 import map 提供），单文件、无 code splitting。

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))
const webDir = join(here, 'web')
const outfile = join(webDir, 'dist', 'entry.js')

/** 壳 vendor：由壳 import map 解析，不打进插件产物。 */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'use-sync-external-store',
  'use-sync-external-store/shim',
]

mkdirSync(dirname(outfile), { recursive: true })
await build({
  entryPoints: [join(webDir, 'entry.tsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNAL,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
})
process.stdout.write(`ui-threads: built ${outfile}\n`)
