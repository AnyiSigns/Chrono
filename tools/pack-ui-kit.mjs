// 打包第一方 UI 套件并分发给各 slot 插件：
//   1) 预编译 src/*.js（Node 禁止对 node_modules 内文件做类型擦除，服务端走 `node` 条件加载它们）；
//   2) `npm pack` 出稳定 tarball；
//   3) 复制进各插件的 `vendor/`，供其 package.json 的 `file:` 依赖在本包内安装。

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KIT = join(ROOT, 'ui-kit')
const TARBALL = 'chrono-ui-kit-0.0.0.tgz'

/** 需要内置 tarball 的 UI 插件（ui-chat 暂不迁移）。 */
export const KIT_CONSUMERS = ['ui-composer', 'ui-sidebar', 'ui-threads', 'ui-approval', 'ui-settings']

const EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', 'use-sync-external-store']

/** 预编译一个入口到同目录同名 `.js`；`.ts(x)` 始终是唯一真源。 */
async function compile(entry, platform) {
  await build({
    entryPoints: [join(KIT, 'src', entry)],
    outfile: join(KIT, 'src', entry.replace(/\.tsx?$/, '.js')),
    bundle: true,
    format: 'esm',
    platform,
    target: 'es2022',
    jsx: 'automatic',
    external: platform === 'browser' ? EXTERNAL : [],
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
  })
}

async function main() {
  await compile('index.ts', 'browser')
  await compile('messages.ts', 'neutral')
  await compile('store.ts', 'neutral')
  await compile('client-read.ts', 'node')

  const outDir = mkdtempSync(join(tmpdir(), 'chrono-ui-kit-pack-'))
  try {
    // 以命令串走 shell 调 npm：Windows 上直接 spawn `npm.cmd` 会失败。
    const packed = spawnSync(`npm pack --pack-destination "${outDir}"`, {
      cwd: KIT,
      encoding: 'utf8',
      shell: true,
    })
    if (packed.status !== 0) {
      throw new Error(`npm pack 失败：${packed.stderr || packed.stdout || `exit ${packed.status}`}`)
    }
    const tarball = join(outDir, TARBALL)
    for (const id of KIT_CONSUMERS) {
      const vendor = join(ROOT, 'plugins', id, 'vendor')
      mkdirSync(vendor, { recursive: true })
      cpSync(tarball, join(vendor, TARBALL))
      process.stdout.write(`vendor: plugins/${id}/vendor/${TARBALL}\n`)
    }
    process.stdout.write(`ui-kit packed: ${TARBALL}\n`)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`pack-ui-kit failed: ${String(err && err.message ? err.message : err)}\n`)
  process.exitCode = 1
})
