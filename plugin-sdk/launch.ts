// 原生服务启动器：定位并拉起宿主依赖恢复产出的 Rust 二进制，stdio 直通、退出码透传。
// 查找口径与宿主注入一致：优先共享 cargo 缓存（`CHRONO_PLUGIN_STATE` 上溯两级 = 宿主 state），
// 再回落包内 `target/release/`；找不到或 spawn 失败退出 127。只用 Node 内置模块。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 原生启动器选项。 */
export interface NativeLaunchOptions {
  /** 二进制名（不含平台后缀；win32 自动加 `.exe`）。 */
  binary: string
  /** 日志前缀；缺省用 binary。 */
  logPrefix?: string
}

/** 给定包根与宿主 ③ 目录，列出原生二进制的候选绝对路径（顺序即查找顺序）。 */
export function nativeBinaryCandidates(options: {
  binary: string
  packageRoot: string
  pluginState?: string
  platform?: NodeJS.Platform
}): string[] {
  const name =
    (options.platform ?? process.platform) === 'win32' ? `${options.binary}.exe` : options.binary
  const candidates: string[] = []
  const state = options.pluginState
  if (typeof state === 'string' && state.length > 0) {
    candidates.push(resolve(state, '..', '..', 'deps', 'cargo-target', 'release', name))
  }
  candidates.push(join(options.packageRoot, 'target', 'release', name))
  return candidates
}

/**
 * 定位并拉起原生二进制：`process.argv.slice(2)` 原样透传、`stdio:'inherit'` 直通、退出码透传；
 * 找不到二进制或 spawn 失败退出 127。本函数是启动器入口，正常路径不返回。
 */
export function launchNative(options: NativeLaunchOptions): void {
  const prefix = options.logPrefix ?? options.binary
  const script = process.argv[1]
  const packageRoot = script === undefined ? process.cwd() : resolve(dirname(script), '..')
  const candidates = nativeBinaryCandidates({
    binary: options.binary,
    packageRoot,
    pluginState: process.env['CHRONO_PLUGIN_STATE'],
  })

  const exe = candidates.find((candidate) => existsSync(candidate))
  if (exe === undefined) {
    process.stderr.write(
      `[${prefix}] launch: binary not found; looked in ${candidates.join(', ')}\n`,
    )
    process.exit(127)
  }

  const child = spawn(exe, process.argv.slice(2), { stdio: 'inherit', windowsHide: true })
  child.on('error', (err) => {
    process.stderr.write(`[${prefix}] launch: ${err.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === null ? 0 : 1))
  })
}
