// UI 客户端半边仓库级构建入口：插件列表从 `plugins/*/plugin.json`（`<id>.client.read` 命令）派生，
// esbuild 配置与壳 vendor 外置清单由 `plugin-sdk/tools/build-ui.mjs` 单源提供。
// 插件 `plugin.json.build` 直接运行共享脚本构建自身，本入口用于本地 / CI 全量构建。

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildPluginDir, uiPluginIds } from '../plugin-sdk/tools/build-ui.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

async function main() {
  const requested = process.argv.slice(2)
  const ids = requested.length > 0 ? requested : uiPluginIds(root)
  let built = 0
  for (const id of ids) {
    const ok = await buildPluginDir(join(root, 'plugins', id))
    if (ok) {
      built += 1
      process.stdout.write(`ui: ${id}/execute/web/dist/entry.js\n`)
    } else {
      process.stdout.write(`ui: ${id} skipped (no entry.tsx)\n`)
    }
  }
  process.stdout.write(`ui client halves built: ${built}\n`)
}

main().catch((err) => {
  process.stderr.write(`build-ui failed: ${String(err && err.message ? err.message : err)}\n`)
  process.exitCode = 1
})
