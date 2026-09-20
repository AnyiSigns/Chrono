// 宿主资产面（G4）：大块二进制（超限附件 / 截图 / 音频 / 导出物）的字节本体。
// 口径（已决 35 + 本轮定案）：
// - 世界只存引用 `{kind:'asset', sha256, mime, size}`（内联在引用方数据里，不设登记身份）；
// - 字节按内容寻址住 `state/assets/<sha256>`（宿主侧 ④ 不可重算，**不进世界、不参与重放**）；
// - 回放只复现引用：字节缺失时 `asset.get` → `asset_missing`（已知限制）；
// - 回收归属：`boot assets gc` 离线持锁，机械扫描世界里的 `kind:'asset'` 引用，删无引用字节；
// - 备份口径：备份世界 ≠ 备份字节，须连同 `state/assets/` 一起备份。

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomic } from './ledger/atomic.ts'
import type { Json, World } from '../kernel/index.ts'

/** 资产引用判别键：宿主机械识别（GC / 校验）只看这个 `kind`。 */
export const ASSET_REF_KIND = 'asset'

/** 单资产原始字节上限：base64 ≈ 10.67MiB < 单帧 16MiB；更大走分块（后置）。 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024

export interface AssetRef {
  kind: 'asset'
  sha256: string
  mime: string
  size: number
}

export type AssetPutResult =
  { ok: true; ref: AssetRef } | { ok: false; code: 'bad_asset' | 'asset_too_large' }

export type AssetGetResult =
  | { ok: true; sha256: string; size: number; bytes: string; mime: string }
  | { ok: false; code: 'bad_asset' | 'asset_missing' }

export interface AssetGcReport {
  removed: string[]
  kept: number
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * mime 旁挂文件后缀：字节本体按内容寻址，mime 是调用方声明、不参与寻址，
 * 故与字节文件同名旁挂（`<sha256>.mime`）；GC / 列举只认 64-hex 名字，旁挂不混入资产清单。
 */
const MIME_SUFFIX = '.mime'

function isRecord(value: Json): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 资产文件名：sha256 十六进制；非 64 hex 一律拒绝（防路径穿越）。 */
export function assetFile(dir: string, sha256: string): string | null {
  if (!SHA256_HEX.test(sha256)) return null
  return resolve(dir, sha256)
}

function assetMimeFile(dir: string, sha256: string): string {
  return resolve(dir, `${sha256}${MIME_SUFFIX}`)
}

function readAssetMime(dir: string, sha256: string): string {
  const file = assetMimeFile(dir, sha256)
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 入库：base64 → 校验 → 内容寻址落盘（已存在即幂等复用）；返回世界侧引用。 */
export function putAsset(dir: string, mime: unknown, bytes: unknown): AssetPutResult {
  if (typeof mime !== 'string' || mime.length === 0) return { ok: false, code: 'bad_asset' }
  if (typeof bytes !== 'string' || bytes.length === 0) return { ok: false, code: 'bad_asset' }
  let decoded: Buffer
  try {
    decoded = Buffer.from(bytes, 'base64')
  } catch {
    return { ok: false, code: 'bad_asset' }
  }
  // 只收规范 base64（防 URL-safe / 脏字符被静默吞掉）：往返一致才认
  if (decoded.toString('base64') !== bytes) return { ok: false, code: 'bad_asset' }
  if (decoded.length > MAX_ASSET_BYTES) return { ok: false, code: 'asset_too_large' }
  const sha256 = createHash('sha256').update(decoded).digest('hex')
  const file = assetFile(dir, sha256)
  if (file === null) return { ok: false, code: 'bad_asset' }
  if (!existsSync(file)) {
    // 原子落盘（temp + fsync + rename）：半截文件不冒充已入库
    writeFileAtomic(file, decoded)
  }
  // mime 与字节同源声明：落旁挂（原子）以便 `get` 原样回带；同字节同 mime 幂等，不重复 fsync
  if (readAssetMime(dir, sha256) !== mime) writeFileAtomic(assetMimeFile(dir, sha256), mime)
  return { ok: true, ref: { kind: ASSET_REF_KIND, sha256, mime, size: decoded.length } }
}

/** 取字节：按 sha256 读回；不存在 → `asset_missing`。mime 缺失时回空串（旧字节）。 */
export function getAsset(dir: string, sha256: unknown): AssetGetResult {
  if (typeof sha256 !== 'string') return { ok: false, code: 'bad_asset' }
  const file = assetFile(dir, sha256)
  if (file === null) return { ok: false, code: 'bad_asset' }
  if (!existsSync(file)) return { ok: false, code: 'asset_missing' }
  const decoded = readFileSync(file)
  return {
    ok: true,
    sha256,
    size: decoded.length,
    bytes: decoded.toString('base64'),
    mime: readAssetMime(dir, sha256),
  }
}

/** 机械收集世界里的资产引用 sha256（枚举 `kind:'asset'` 对象；显式栈、不递归爆栈）。 */
export function collectAssetRefs(world: World): Set<string> {
  const keep = new Set<string>()
  const stack: Json[] = Object.values(world.defs).map((def) => def as unknown as Json)
  while (stack.length > 0) {
    const value = stack.pop() as Json
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    if (!isRecord(value)) continue
    if (value['kind'] === ASSET_REF_KIND && typeof value['sha256'] === 'string') {
      keep.add(value['sha256'])
    }
    for (const item of Object.values(value)) stack.push(item)
  }
  return keep
}

/**
 * 离线回收：删除资产区里「世界无引用」的字节。
 * 只动 64-hex 命名的文件（临时文件 / 非资产文件不碰）；字节被删时连带删其 mime 旁挂，
 * 并清理字节已不在的孤儿旁挂；返回被删清单与保留数。
 */
export function gcAssets(dir: string, keep: ReadonlySet<string>): AssetGcReport {
  if (!existsSync(dir)) return { removed: [], kept: 0 }
  const removed: string[] = []
  let kept = 0
  for (const name of readdirSync(dir)) {
    if (name.endsWith(MIME_SUFFIX)) {
      // 孤儿旁挂（字节本体已不在）：一并清掉，不留悬空元数据
      const base = name.slice(0, -MIME_SUFFIX.length)
      if (SHA256_HEX.test(base) && !existsSync(resolve(dir, base))) {
        rmSync(resolve(dir, name), { force: true })
      }
      continue
    }
    if (!SHA256_HEX.test(name)) continue
    if (keep.has(name)) {
      kept += 1
      continue
    }
    rmSync(resolve(dir, name), { force: true })
    rmSync(assetMimeFile(dir, name), { force: true })
    removed.push(name)
  }
  return { removed: removed.sort(), kept }
}

/** 资产区现状（离线 GC 报告 / 诊断用）：只列 64-hex 文件。 */
export function listAssets(dir: string): { sha256: string; size: number }[] {
  if (!existsSync(dir)) return []
  const out: { sha256: string; size: number }[] = []
  for (const name of readdirSync(dir)) {
    if (!SHA256_HEX.test(name)) continue
    out.push({ sha256: name, size: statSync(resolve(dir, name)).size })
  }
  return out.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1))
}
