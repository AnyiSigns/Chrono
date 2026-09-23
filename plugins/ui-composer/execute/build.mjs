// 客户端半边打包（构建期运行，非服务进程）：execute/web/entry.tsx → execute/web/dist/entry.js。
// 走 esbuild JS API：CLI 的字符串选项需要 `=`（如 `--format=esm`），与宿主 `build` 令牌
// 白名单「不含 =」冲突，故用脚本承载，声明侧只写 `node execute/build.mjs`。
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const entry = fileURLToPath(new URL('./web/entry.tsx', import.meta.url))
const outfile = fileURLToPath(new URL('./web/dist/entry.js', import.meta.url))

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    'use-sync-external-store',
    'use-sync-external-store/shim',
  ],
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
})
