#!/usr/bin/env node
// Chrono 启动器：一条命令完成「生成插件清单 → 入世 → 后台起宿主 → 打印入口」。
// 用法：node start.mjs [start|stop|status|seed]（缺省 start）。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const BOOT = join(ROOT, 'packages', 'boot', 'main.ts')
const HOST = join(ROOT, 'packages', 'host', 'main.ts')
const MANIFEST = join(ROOT, 'state', 'plugins.json')
const UI_PORT = Number(process.env.CHRONO_UI_PORT ?? 8787)

function runBoot(args) {
  return spawnSync(process.execPath, [BOOT, '--root', ROOT, ...args], { cwd: ROOT, stdio: 'inherit' })
}

/**
 * 入世：pins 需按依赖序解析，而清单是编号序，故逐轮重跑 seed（幂等）直到无失败项。
 * 收敛后所有身份均在世界里；未收敛则打印失败项并继续（坏分支由装配期 fail-closed 隔离）。
 */
function seedUntilResolved() {
  for (let pass = 1; pass <= 12; pass++) {
    const result = spawnSync(process.execPath, [BOOT, '--root', ROOT, 'seed'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    let report
    try {
      report = JSON.parse(result.stdout)
    } catch {
      process.stderr.write(result.stderr || result.stdout)
      throw new Error('seed 输出无法解析')
    }
    const failed = report.items.filter((item) => item.status === 'failed')
    console.log(`入世第 ${pass} 轮：${failed.length === 0 ? '全部就位' : `待解析 ${failed.map((item) => item.name).join(', ')}`}`)
    if (report.ok) return
    if (pass === 12) {
      console.warn(`入世未完全收敛，失败项：${failed.map((item) => `${item.name}(${item.reasons.join('|')})`).join(', ')}`)
    }
  }
}

/** 无清单时按 plugins/ 生成（排除模板 example）；已有清单沿用，尊重手工改动。 */
function ensureManifest() {
  if (existsSync(MANIFEST)) {
    console.log('沿用现有 state/plugins.json')
    return
  }
  const dir = join(ROOT, 'plugins')
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(
      (item) =>
        item.isDirectory() && item.name !== 'example' && existsSync(join(dir, item.name, 'plugin.json')),
    )
    .map((item) => ({ name: item.name, path: `plugins/${item.name}` }))
  writeFileSync(MANIFEST, `${JSON.stringify(entries, null, 2)}\n`)
  console.log(`已生成 state/plugins.json：${entries.length} 项`)
}

/** 壳主端口是否已就绪；未连上 / 未就绪一律返回 null。 */
async function probe() {
  try {
    const response = await fetch(`http://127.0.0.1:${UI_PORT}/api/state`)
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/** 后台起宿主：detached + unref，日志丢弃，不阻塞本进程。 */
function startHostDetached() {
  const child = spawn(process.execPath, [HOST, '--root', ROOT, '--call-timeout-ms', '30000'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    // npm 12 默认 allow-remote=none，会让宿主物化含依赖的插件（如 model-protocol）时 npm ci 失败（deps_failed）
    env: { ...process.env, npm_config_allow_remote: 'all' },
  })
  child.unref()
  return child.pid
}

const command = process.argv[2] ?? 'start'

if (command === 'stop') {
  runBoot(['stop'])
} else if (command === 'status') {
  runBoot(['status'])
} else if (command === 'seed') {
  ensureManifest()
  seedUntilResolved()
} else if (command === 'start') {
  const running = await probe()
  if (running !== null) {
    console.log(`宿主已在运行：http://127.0.0.1:${UI_PORT}（${JSON.stringify(running)}）`)
  } else {
    ensureManifest()
    seedUntilResolved()
    const pid = startHostDetached()
    console.log(`宿主已丢后台（pid ${pid}）；浏览器打开 http://127.0.0.1:${UI_PORT}`)
    console.log('首次会物化 Rust 子组件，就绪需数十秒到数分钟：就绪看 node start.mjs status 或稍候刷新页面；停止 node start.mjs stop')
  }
} else {
  console.error('用法：node start.mjs [start|stop|status|seed]')
  process.exit(1)
}
