#!/usr/bin/env node
// Chrono 启动器：一条命令完成「生成插件清单 → 入世 → 前台起宿主」。
// 用法：node start.mjs [start|status|seed]（缺省 start）。
// 宿主前台常驻，日志直出终端；Ctrl-C 由宿主处理，其自身 drain 全部插件后退出。

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
 * 入世：seed 内部已按 pins 名级拓扑序一次入世（被依赖者先），此处不再重跑。
 * 失败项由装配期 fail-closed 隔离，故打印失败清单后继续启动。
 */
function seedOnce() {
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
  console.log(`入世：${failed.length === 0 ? '全部就位' : `待解析 ${failed.map((item) => item.name).join(', ')}`}`)
  if (!report.ok) {
    console.warn(`入世未完全收敛，失败项：${failed.map((item) => `${item.name}(${item.reasons.join('|')})`).join(', ')}`)
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

/**
 * 前台起宿主：stdio 继承，宿主 stdout 与插件 stderr 直出终端。
 * 本进程忽略 SIGINT/SIGTERM，Ctrl-C 只交给宿主处理（宿主自行 drain 全部插件），
 * 等子进程退出后以同码退出，避免先于 drain 结束就返回提示符。
 */
function startHostForeground() {
  const child = spawn(process.execPath, [HOST, '--root', ROOT, '--call-timeout-ms', '30000'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  const ignoreSignal = () => {}
  process.on('SIGINT', ignoreSignal)
  process.on('SIGTERM', ignoreSignal)
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal !== null ? 1 : 0)))
  })
}

const command = process.argv[2] ?? 'start'

if (command === 'status') {
  runBoot(['status'])
} else if (command === 'seed') {
  ensureManifest()
  seedOnce()
} else if (command === 'start') {
  const running = await probe()
  if (running !== null) {
    console.log(`宿主已在运行：http://127.0.0.1:${UI_PORT}（${JSON.stringify(running)}）`)
  } else {
    ensureManifest()
    seedOnce()
    console.log(`前台起宿主；浏览器打开 http://127.0.0.1:${UI_PORT}，Ctrl-C 停止全部插件`)
    console.log('首次会物化 Rust 子组件，就绪需数十秒到数分钟')
    process.exitCode = await startHostForeground()
  }
} else {
  console.error('用法：node start.mjs [start|status|seed]')
  process.exit(1)
}
