// 生态 profile：宿主对「语言 / 工具链」的默认假设集中在此——锁文件名、通用排除名、
// npm / cargo 缓存环境变量、SDK 包布局、同语言入口扩展名。默认即存量行为（逐字节等价）。
// 可由仓库根 `chrono.config.json` 的 `ecosystem` 键整体或部分覆盖：缺省（未配置）时不产生任何行为变化。
// 覆盖采用「声明式默认 profile」而非运行期注册表：解析点在读取处，无全局可变状态。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Json } from '../../kernel/index.ts'
import { isRecord } from '../common/json.ts'
import { CONFIG_FILE, ECOSYSTEM_ENV, ECOSYSTEM_KEY, resolveEcosystem } from '../options.ts'
import type { EcosystemOverrides } from '../options.ts'

/** 宿主内建的生态假设；未配置覆盖时全部走它。 */
export interface EcosystemProfile {
  /** 契约必需锁文件名（存在即不可被 `.worldignore` 排除）。 */
  readonly lockFiles: readonly string[]
  /** 源码树通用排除名（依赖目录与版本库元数据）。 */
  readonly sourceExcludedNames: ReadonlySet<string>
  /** npm 缓存目录环境变量名与目录名（`depsDir/<目录名>`）。 */
  readonly npmCacheEnvVar: string
  readonly npmCacheDirName: string
  /** npm 远端拉取开关环境变量名与值。 */
  readonly npmAllowRemoteEnvVar: string
  readonly npmAllowRemoteValue: string
  /** cargo 目标目录环境变量名与目录名（`depsDir/<目录名>`）。 */
  readonly cargoTargetEnvVar: string
  readonly cargoTargetDirName: string
  /** 顶层 SDK 包目录名（框架安装布局：与 `packages/` 同级）。 */
  readonly sdkPackageName: string
  /** 顶层第一方契约包目录名（框架安装布局：与 `packages/` 同级）。 */
  readonly contractPackageName: string
  /** 物化树内的依赖目录名。 */
  readonly sdkNodeModulesDir: string
  /** SDK crate 在 SDK 包内的目录名（`<sdkDir>/<目录名>/Cargo.toml`）。 */
  readonly sdkRustDirName: string
  /** 同语言入口扩展名（`inproc` / `worker` 只接受这类入口；无点，供正则拼接）。 */
  readonly entryExtensions: readonly string[]
}

/** 内建默认 profile：与集中前的硬编码逐字节一致。 */
export const DEFAULT_ECOSYSTEM: EcosystemProfile = {
  lockFiles: [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
  ],
  sourceExcludedNames: new Set(['node_modules', '.git']),
  npmCacheEnvVar: 'npm_config_cache',
  npmCacheDirName: 'npm',
  npmAllowRemoteEnvVar: 'npm_config_allow_remote',
  npmAllowRemoteValue: 'all',
  cargoTargetEnvVar: 'CARGO_TARGET_DIR',
  cargoTargetDirName: 'cargo-target',
  sdkPackageName: 'plugin-sdk',
  contractPackageName: 'chain-contract',
  sdkNodeModulesDir: 'node_modules',
  sdkRustDirName: 'rust',
  entryExtensions: ['mjs', 'cjs', 'js', 'mts', 'cts', 'ts', 'jsx', 'tsx'],
}

/** 生态 profile 读取结果：形态非法 → `bad_ecosystem`（调用方 fail-closed）。 */
export type EcosystemRead =
  { ok: true; profile: EcosystemProfile } | { ok: false; reason: 'bad_ecosystem' }

/** 把已校验的部分覆盖叠到内建默认上；未给的字段保持默认。 */
function mergeEcosystem(overrides: Partial<EcosystemOverrides>): EcosystemProfile {
  return {
    lockFiles: overrides.lockFiles ?? DEFAULT_ECOSYSTEM.lockFiles,
    sourceExcludedNames:
      overrides.sourceExcludedNames !== undefined
        ? new Set(overrides.sourceExcludedNames)
        : DEFAULT_ECOSYSTEM.sourceExcludedNames,
    npmCacheEnvVar: overrides.npmCacheEnvVar ?? DEFAULT_ECOSYSTEM.npmCacheEnvVar,
    npmCacheDirName: overrides.npmCacheDirName ?? DEFAULT_ECOSYSTEM.npmCacheDirName,
    npmAllowRemoteEnvVar: overrides.npmAllowRemoteEnvVar ?? DEFAULT_ECOSYSTEM.npmAllowRemoteEnvVar,
    npmAllowRemoteValue: overrides.npmAllowRemoteValue ?? DEFAULT_ECOSYSTEM.npmAllowRemoteValue,
    cargoTargetEnvVar: overrides.cargoTargetEnvVar ?? DEFAULT_ECOSYSTEM.cargoTargetEnvVar,
    cargoTargetDirName: overrides.cargoTargetDirName ?? DEFAULT_ECOSYSTEM.cargoTargetDirName,
    sdkPackageName: overrides.sdkPackageName ?? DEFAULT_ECOSYSTEM.sdkPackageName,
    contractPackageName: DEFAULT_ECOSYSTEM.contractPackageName,
    sdkNodeModulesDir: overrides.sdkNodeModulesDir ?? DEFAULT_ECOSYSTEM.sdkNodeModulesDir,
    sdkRustDirName: overrides.sdkRustDirName ?? DEFAULT_ECOSYSTEM.sdkRustDirName,
    entryExtensions: overrides.entryExtensions ?? DEFAULT_ECOSYSTEM.entryExtensions,
  }
}

/** 读 `chrono.config.json` 的 `ecosystem` 键；文件 / 键缺失 → `value: undefined`；JSON 坏 → `ok:false`。 */
function readConfigValue(root: string): { ok: true; value: Json | undefined } | { ok: false } {
  const file = join(root, CONFIG_FILE)
  if (!existsSync(file)) return { ok: true, value: undefined }
  let parsed: Json
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch {
    return { ok: false }
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, ECOSYSTEM_KEY)) {
    return { ok: true, value: undefined }
  }
  return { ok: true, value: parsed[ECOSYSTEM_KEY] }
}

/**
 * 读仓库根的生态 profile：显式 / 环境覆盖 > 文件 `ecosystem` > 内建默认。
 * 文件缺失 / 键缺失即内建默认（零行为变化）；文件 JSON 坏或覆盖形态非法 → `bad_ecosystem`。
 */
export function readEcosystem(root: string): EcosystemRead {
  const config = readConfigValue(root)
  if (!config.ok) return { ok: false, reason: 'bad_ecosystem' }
  const resolved = resolveEcosystem(undefined, process.env[ECOSYSTEM_ENV], config.value)
  if (!resolved.ok) return { ok: false, reason: 'bad_ecosystem' }
  return { ok: true, profile: mergeEcosystem(resolved.overrides) }
}
