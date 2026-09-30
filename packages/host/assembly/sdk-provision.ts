// 插件 SDK 运行期供给：在物化树内建 `node_modules/plugin-sdk` 链接，指向框架安装的顶层
// `plugin-sdk`，使插件服务裸导入 `plugin-sdk` 在任意宿主根下都能解析。
// 用链接而非复制：SDK 以 TS 源码发布，Node 的类型剥离对 `node_modules` 下的文件不生效；
// 链接经 realpath 指回框架安装目录（不在 `node_modules` 下），类型剥离与仓库内解析同路。
// Rust 侧同理：物化树里的 `Cargo.toml` 以相对路径 `../../plugin-sdk/rust` 依赖 SDK crate，
// 宿主在物化树两级之上建同名 `plugin-sdk` 链接，故该相对路径在任意宿主根下都解析到框架安装。
// SDK 是插件侧库、不随插件入世、不进世界；宿主只按数据定位它，不 import 它
// （packages/* 与 SDK 之间没有源码依赖）。

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { symlinkDirOrJunction } from '../common/platform/index.ts'
import { DEFAULT_ECOSYSTEM } from './ecosystem.ts'
import type { EcosystemProfile } from './ecosystem.ts'

/**
 * 框架安装里的 SDK 目录：从本模块位置向上定位与 `packages/` 同级的 SDK 包目录。
 * 这是「SDK 顶层独立包」布局的机械定位，不依赖宿主根下是否安装过 `node_modules`。
 */
export function frameworkSdkDir(ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM): string {
  // packages/host/assembly/sdk-provision.ts → packages/host/assembly → packages/host → packages → 仓库根
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    ecosystem.sdkPackageName,
  )
}

/**
 * 在物化树内供给 SDK：`<cwd>/node_modules/plugin-sdk` 链到框架安装的 SDK 目录。
 * 幂等：先移除旧落点（只解链，绝不跟进目标）再建链，保证指向当前框架安装。
 * SDK 目录缺失即抛错，由调用方按准备阶段失败（`deps_failed`）收口。
 */
export function provisionPluginSdk(
  cwd: string,
  sdkDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): void {
  const source = resolve(sdkDir ?? frameworkSdkDir(ecosystem))
  if (!existsSync(join(source, 'package.json'))) {
    throw new Error(`plugin_sdk_missing:${source}`)
  }
  const target = join(cwd, ecosystem.sdkNodeModulesDir, ecosystem.sdkPackageName)
  removeExisting(target)
  mkdirSync(dirname(target), { recursive: true })
  symlinkDirOrJunction(target, source)
}

/**
 * Rust SDK 供给：物化树的 `Cargo.toml` 以相对路径 `../../plugin-sdk/rust` 依赖 SDK crate，
 * 故在物化目录两级之上建 `plugin-sdk` 链接（任意宿主根下 = `<宿主根>/state/runtime/plugin-sdk`），
 * 使该相对路径解析到框架安装的 SDK crate。必须早于依赖恢复 / 构建（cargo 解析路径依赖时就要找到它）。
 * 并发物化时多插件共写同一落点，故已指向框架安装则跳过、建链撞车时再复核一次。
 */
export function provisionRustPluginSdk(
  cwd: string,
  sdkDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): void {
  const source = resolve(sdkDir ?? frameworkSdkDir(ecosystem))
  if (!existsSync(join(source, ecosystem.sdkRustDirName, 'Cargo.toml'))) {
    throw new Error(`plugin_sdk_rust_missing:${source}`)
  }
  const target = resolve(cwd, '..', '..', ecosystem.sdkPackageName)
  if (isLinkTo(target, source)) return
  removeExisting(target)
  mkdirSync(dirname(target), { recursive: true })
  try {
    symlinkDirOrJunction(target, source)
  } catch (err) {
    // 并发下另一物化已建好同一落点：复核后放行，否则原样上抛。
    if (!isLinkTo(target, source)) throw err
  }
}

/** 落点是否已是指向 `source` 的链接（并发供给的幂等判据）。 */
function isLinkTo(target: string, source: string): boolean {
  try {
    if (!lstatSync(target).isSymbolicLink()) return false
    return realpathSync(target) === realpathSync(source)
  } catch {
    return false
  }
}

/** 删除已有落点：链接只解链（不跟进目标，避免误删框架安装），普通目录才递归删。 */
function removeExisting(target: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(target)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) unlinkSync(target)
  else rmSync(target, { recursive: true, force: true })
}
