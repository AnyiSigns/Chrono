// 插件 SDK 运行期供给：在物化树内建 `node_modules/plugin-sdk` 链接，指向框架安装的顶层
// `plugin-sdk`，使插件服务裸导入 `plugin-sdk` 在任意宿主根下都能解析。
// 用链接而非复制：SDK 以 TS 源码发布，Node 的类型剥离对 `node_modules` 下的文件不生效；
// 链接经 realpath 指回框架安装目录（不在 `node_modules` 下），类型剥离与仓库内解析同路。
// SDK 是插件侧库、不随插件入世、不进世界；宿主只按数据定位它，不 import 它
// （packages/* 与 SDK 之间没有源码依赖）。

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 顶层 SDK 包目录名（框架安装布局：与 `packages/` 同级）。 */
const SDK_PACKAGE_NAME = 'plugin-sdk'

/** 物化树内的依赖目录名。 */
const NODE_MODULES_DIR = 'node_modules'

/**
 * 框架安装里的 SDK 目录：从本模块位置向上定位与 `packages/` 同级的 `plugin-sdk/`。
 * 这是「SDK 顶层独立包」布局的机械定位，不依赖宿主根下是否安装过 `node_modules`。
 */
export function frameworkSdkDir(): string {
  // packages/host/assembly/sdk-provision.ts → packages/host/assembly → packages/host → packages → 仓库根
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', SDK_PACKAGE_NAME)
}

/**
 * 在物化树内供给 SDK：`<cwd>/node_modules/plugin-sdk` 链到框架安装的 SDK 目录。
 * 幂等：先移除旧落点（只解链，绝不跟进目标）再建链，保证指向当前框架安装。
 * SDK 目录缺失即抛错，由调用方按准备阶段失败（`deps_failed`）收口。
 */
export function provisionPluginSdk(cwd: string, sdkDir: string = frameworkSdkDir()): void {
  const source = resolve(sdkDir)
  if (!existsSync(join(source, 'package.json'))) {
    throw new Error(`plugin_sdk_missing:${source}`)
  }
  const target = join(cwd, NODE_MODULES_DIR, SDK_PACKAGE_NAME)
  removeExisting(target)
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
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
