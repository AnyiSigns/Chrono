// UI 客户端半边统一打包：全仓唯一一份 esbuild 配置与壳 vendor 外置清单。
// 两种调用方式：
//   - 直接运行（无参数）：构建当前目录插件，读同目录 `plugin.json` 定位 `execute/web/entry.tsx`；
//     宿主物化前的 `plugin.json.build` 步骤即走此形。
//   - 仓库入口 `tools/build-ui.mjs` 导入本模块，扫描 `plugins/*/plugin.json` 逐个构建。
// 产物落 `execute/web/dist/entry.js`，本地 ESM；壳 vendor 由壳 import map 解析，不打进产物。

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

/** 壳 vendor 运行时：由壳 import map 解析，不打进插件产物。 */
export const VENDOR_EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'use-sync-external-store',
  'use-sync-external-store/shim',
]

/** 判定插件是否带 UI 客户端半边：声明了 `<identity>.client.read` 只读命令。 */
export function isUiPlugin(decl) {
  if (decl === null || typeof decl !== 'object') return false
  const identity = decl.identity
  if (typeof identity !== 'string' || identity.length === 0) return false
  const commands = decl.commands
  return (
    Array.isArray(commands) &&
    commands.some((command) => command !== null && typeof command === 'object' && command.name === `${identity}.client.read`)
  )
}

/** 扫描仓库各插件目录下的 `plugin.json`，按目录名序返回带客户端半边的插件 id。 */
export function uiPluginIds(root = REPO_ROOT) {
  const pluginsDir = join(root, 'plugins')
  const ids = []
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const declPath = join(pluginsDir, entry.name, 'plugin.json')
    if (!existsSync(declPath)) continue
    let decl
    try {
      decl = JSON.parse(readFileSync(declPath, 'utf8'))
    } catch {
      continue
    }
    if (isUiPlugin(decl)) ids.push(entry.name)
  }
  return ids.sort()
}

/** 解析插件目录内可用的 esbuild：优先插件自身的 `node_modules`，回落上层（仓库根）安装。 */
async function loadEsbuild(pluginDir) {
  const require = createRequire(pathToFileURL(join(pluginDir, 'package.json')))
  const resolved = require.resolve('esbuild')
  return import(pathToFileURL(resolved).href)
}

/** 打包单个插件目录：`execute/web/entry.tsx` → `execute/web/dist/entry.js`；无入口返回 false。 */
export async function buildPluginDir(pluginDir) {
  const entry = join(pluginDir, 'execute', 'web', 'entry.tsx')
  if (!existsSync(entry)) return false
  const outfile = join(pluginDir, 'execute', 'web', 'dist', 'entry.js')
  mkdirSync(dirname(outfile), { recursive: true })
  const { build } = await loadEsbuild(pluginDir)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: VENDOR_EXTERNAL,
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
  })
  return true
}

async function main() {
  const requested = process.argv.slice(2)
  const targets =
    requested.length > 0
      ? requested.map((id) => ({ label: id, dir: join(REPO_ROOT, 'plugins', id) }))
      : [{ label: process.cwd(), dir: process.cwd() }]
  let built = 0
  for (const { label, dir } of targets) {
    const ok = await buildPluginDir(dir)
    if (ok) {
      built += 1
      process.stdout.write(`ui: ${label}/execute/web/dist/entry.js\n`)
    } else {
      process.stdout.write(`ui: ${label} skipped (no entry.tsx)\n`)
    }
  }
  process.stdout.write(`ui client halves built: ${built}\n`)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`build-ui failed: ${String(err && err.message ? err.message : err)}\n`)
    process.exitCode = 1
  })
}
