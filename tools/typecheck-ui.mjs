// UI 客户端半边类型门禁：对每个带客户端半边的 UI 插件跑 `tsc --noEmit`。
// 插件列表从 `plugins/*/plugin.json`（`<id>.client.read` 命令）派生；类型不通过即非零退出。

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { uiPluginIds } from '../plugin-sdk/tools/build-ui.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

let checked = 0
let failed = 0

for (const id of uiPluginIds(root)) {
  const project = join(root, 'plugins', id, 'tsconfig.json')
  if (!existsSync(project)) continue
  checked += 1
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project], {
    cwd: join(root, 'plugins', id),
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    failed += 1
    process.stderr.write(`typecheck failed: ${id}\n`)
  } else {
    process.stdout.write(`typecheck ok: ${id}\n`)
  }
}

process.stdout.write(`typecheck: ${checked} checked, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
