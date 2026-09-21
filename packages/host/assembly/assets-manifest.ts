// 投递目录大资产直拷：`schema` 顶层 `assets_manifest` 声明的、被 `.worldignore` 排除的大资产，
// 物化后按清单从投递包源目录复制进物化目录并按 sha256 校验。
// 宿主不触网、不认识资产内容；源文件缺失 / 大小或哈希不符与依赖恢复同归 `deps_failed`。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ServiceStartError } from './supervision.ts'
import type { Json, World } from '../../kernel/index.ts'

export interface AssetManifestEntry {
  path: string
  sha256: string
  size: number
}

export type AssetsManifestRead =
  { ok: true; entries: AssetManifestEntry[] } | { ok: false; reason: string }

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 包内相对路径必须是安全单段路径：禁 `..` 段、绝对路径、盘符与反斜杠（防逃逸物化目录）。 */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (path.includes('\\')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  const segments = path.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  return segments.length > 0 && !segments.some((segment) => segment === '..')
}

/**
 * 读身份的 `schema` def 顶层 `assets_manifest`（无声明 → 空表）。
 * 声明非法（非数组 / 项缺字段或类型不符 / 路径不安全 / sha256 非 64hex）只回 `ok:false`，
 * 由调用方记运维日志、按无清单处理（不阻断装载，见插件规范「schema 宿主消费键」）。
 */
export function readAssetsManifest(world: World, identityId: string): AssetsManifestRead {
  const identity = world.ids[identityId]
  const schema = identity === undefined ? undefined : world.defs[identity.schema]?.body
  if (!isRecord(schema)) return { ok: true, entries: [] }
  const raw = schema['assets_manifest']
  if (raw === undefined) return { ok: true, entries: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'assets_manifest_invalid' }
  const entries: AssetManifestEntry[] = []
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, reason: 'assets_manifest_invalid' }
    const path = item['path']
    const sha256 = item['sha256']
    const size = item['size']
    if (typeof path !== 'string' || !isSafeRelativePath(path)) {
      return { ok: false, reason: 'assets_manifest_invalid' }
    }
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      return { ok: false, reason: 'assets_manifest_invalid' }
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      return { ok: false, reason: 'assets_manifest_invalid' }
    }
    entries.push({ path, sha256, size })
  }
  return { ok: true, entries }
}

/**
 * 按清单从 `sourceDir` 直拷到 `targetDir`：逐项校验大小与 sha256，任一不符抛 `deps_failed`。
 * 不做部分成功回滚——物化目录是 ③ 可重算产物，失败后整目录可重物化。
 */
export function copyAssetsManifest(
  entries: AssetManifestEntry[],
  sourceDir: string,
  targetDir: string,
): void {
  for (const entry of entries) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(sourceDir, entry.path))
    } catch {
      throw new ServiceStartError('deps_failed')
    }
    if (bytes.length !== entry.size) throw new ServiceStartError('deps_failed')
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== entry.sha256) throw new ServiceStartError('deps_failed')
    const target = join(targetDir, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
}
