// UI 客户端半边打包：每个 slot 插件 `execute/web/entry.tsx` → `execute/web/dist/entry.js`。
// 产物为本地 ESM，vendor（react / react-dom / jsx-runtime / use-sync-external-store）外置，
// 由壳的 import map 解析；dist 随包入世，由壳经 host.source.read 以 /assets/ui/<id>.js 同源服务。

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

/** 有 slot 客户端半边的插件（源为 execute/web/entry.tsx）。 */
export const UI_PLUGINS = [
  'ui-chat',
  'ui-composer',
  'ui-sidebar',
  'ui-threads',
  'ui-approval',
  'ui-settings',
]

/** vendor 运行时由壳 import map 提供，不打进插件产物。 */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'use-sync-external-store',
  'use-sync-external-store/shim',
]

/** 打包单个插件；无 entry.tsx 返回 false。 */
export async function buildPlugin(id) {
  const dir = join(root, 'plugins', id, 'execute', 'web')
  const entry = join(dir, 'entry.tsx')
  if (!existsSync(entry)) return false
  const outfile = join(dir, 'dist', 'entry.js')
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [entry],
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
  return true
}

async function main() {
  const requested = process.argv.slice(2)
  const targets = requested.length > 0 ? requested : UI_PLUGINS
  let built = 0
  for (const id of targets) {
    const ok = await buildPlugin(id)
    if (ok) {
      built += 1
      process.stdout.write(`ui: ${id}/execute/web/dist/entry.js\n`)
    } else {
      process.stdout.write(`ui: ${id} skipped (no entry.tsx)\n`)
    }
  }
  process.stdout.write(`ui client halves built: ${built}\n`)
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`build-ui failed: ${String(err && err.message ? err.message : err)}\n`)
    process.exitCode = 1
  })
}
