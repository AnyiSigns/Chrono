// 原生 tokenizer 子组件的定位与加载（单一实现红线）。
//
// 定位顺序：
//   1) `<CHRONO_PLUGIN_STATE>/../../deps/cargo-target/release/tokenizer.dll|libtokenizer.so`
//      （CHRONO_PLUGIN_STATE = `<root>/state/plugins/<id>`，上溯两级 = `<root>/state`；与
//       `plugins/sandbox/execute/launch.mjs` 同一路径口径）；
//   2) 包内 `target/release/`（本地开发 / 测试，默认 CARGO_TARGET_DIR 的产物）。
// 找到后复制为 `.node`（宿主侧落 CHRONO_PLUGIN_STATE，本地落产物同目录）再 `require`。
// 找不到 / 加载失败 ⇒ 抛错 ⇒ 服务在 hello 前退出非 0（宿主隔离）；绝不回落 JS 计数。

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const require = createRequire(import.meta.url)

/** 平台产物名：Windows 为 `<name>.dll`，类 Unix cdylib 为 `lib<name>.so`（兼容 `<name>.so`）。 */
const LIB_NAMES =
  process.platform === 'win32' ? ['tokenizer.dll'] : ['libtokenizer.so', 'tokenizer.so']

interface NativeAddon {
  countText: (text: string) => number
  estimatorVersion: () => string
  otherBucket: () => number
}

/** 推导候选目录（按顺序）。 */
export function nativeSearchDirs(): string[] {
  const dirs: string[] = []
  const state = process.env.CHRONO_PLUGIN_STATE
  if (typeof state === 'string' && state.length > 0) {
    dirs.push(resolve(state, '..', '..', 'deps', 'cargo-target', 'release'))
  }
  dirs.push(join(PKG_ROOT, 'target', 'release'))
  return dirs
}

/** 找到原生库文件路径；找不到返回 null。 */
export function findNativeLibrary(): string | null {
  for (const dir of nativeSearchDirs()) {
    for (const name of LIB_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

let addon: NativeAddon | null = null
let loadedFrom: string | null = null

/**
 * 加载原生 tokenizer；失败抛错（调用方据此在 hello 前退出非 0）。
 * 副本名带 pid：并发进程（如换代期间新旧服务并存）各自加载独立副本，避免覆盖已加载的 `.node`
 * （Windows 会锁住已加载的 DLL）。幂等：同一进程重复调用复用已加载实例。
 */
export function loadTokenizer(): NativeAddon {
  if (addon !== null) return addon
  const library = findNativeLibrary()
  if (library === null) {
    throw new Error(`tokenizer native library not found; looked in ${nativeSearchDirs().join(', ')}`)
  }
  const state = process.env.CHRONO_PLUGIN_STATE
  const destDir =
    typeof state === 'string' && state.length > 0 ? state : dirname(library)
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, `tokenizer.${process.pid}.node`)
  copyFileSync(library, dest)
  const loaded = require(dest) as Partial<NativeAddon>
  if (typeof loaded.countText !== 'function' || typeof loaded.estimatorVersion !== 'function') {
    throw new Error(`tokenizer addon at ${dest} does not export countText/estimatorVersion`)
  }
  addon = {
    countText: loaded.countText,
    estimatorVersion: loaded.estimatorVersion,
    otherBucket: typeof loaded.otherBucket === 'function' ? loaded.otherBucket : () => 4,
  }
  loadedFrom = dest
  return addon
}

/** 原生库来源路径（诊断用；未加载时为 null）。 */
export function nativeLoadedFrom(): string | null {
  return loadedFrom
}

/** 按 v1 估算器计数（唯一实现：原生扩展）。 */
export function countTokens(text: string): number {
  return loadTokenizer().countText(text)
}

/** 估算器规格版本。 */
export function tokenizerVersion(): string {
  return loadTokenizer().estimatorVersion()
}
