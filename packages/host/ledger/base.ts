// 基础世界文件（G6）：快照位置 + 世界本体 + 审计索引（紧凑引用）。
// 宿主侧派生缓存（③ 可重算）：丢了可由「冷段 + 尾段」全链重放重建；链上的 `snapshot` entry
// 只记凭证与位置、不携带本体（kernel.md §八），本体真源在宿主——这里。
// 读侧 fail-closed：形态 / world_rev 自校不符即 `bad_base`（损坏不静默回落）。

import { existsSync, readFileSync } from 'node:fs'
import { worldRev } from '../../kernel/index.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'
import { writeFileAtomic } from './atomic.ts'

export const BASE_VERSION = 1

/** 审计索引的紧凑引用：body 从基础世界 `defs[hash]` 取回（不重复存 body）。 */
export interface BaseAuditRef {
  seq: number
  at: number
  by: string
  hash: Hash
}

export interface BaseFile {
  v: number
  snapshot: { seq: number; hash: Hash }
  worldRev: Hash
  world: World
  audits: BaseAuditRef[]
}

/** 审计记录 → 紧凑引用：`hash` 是审计 def 键（写侧已带，不再重算）。 */
export function auditRefOf(record: {
  seq: number
  at: number
  by: string
  hash: Hash
}): BaseAuditRef {
  return { seq: record.seq, at: record.at, by: record.by, hash: record.hash }
}

function isRecord(value: unknown): value is { [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读基础世界文件；缺文件 → null；形态 / 内容自校不符 → 抛 `bad_base`。 */
export function readBase(file: string): BaseFile | null {
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('bad_base')
  }
  if (!isRecord(parsed) || parsed['v'] !== BASE_VERSION) throw new Error('bad_base')
  const snapshot = parsed['snapshot']
  const world = parsed['world']
  if (
    !isRecord(snapshot) ||
    typeof snapshot['seq'] !== 'number' ||
    typeof snapshot['hash'] !== 'string' ||
    !isRecord(world) ||
    !isRecord(world['defs']) ||
    !isRecord(world['ids']) ||
    typeof parsed['worldRev'] !== 'string' ||
    !Array.isArray(parsed['audits'])
  ) {
    throw new Error('bad_base')
  }
  const base: BaseFile = {
    v: BASE_VERSION,
    snapshot: { seq: snapshot['seq'], hash: snapshot['hash'] },
    worldRev: parsed['worldRev'],
    world: world as unknown as World,
    audits: parsed['audits'] as BaseAuditRef[],
  }
  // 内容自校：世界本体须与记的 world_rev 一致（防半截 / 手改）；畸形 world 一律映射为 bad_base
  try {
    if (worldRev(base.world) !== base.worldRev) throw new Error('bad_base')
  } catch {
    throw new Error('bad_base')
  }
  // 审计引用必须都能在世界里**自有键**寻址（`Object.hasOwn` 防 `__proto__` 原型链绕过）
  for (const ref of base.audits) {
    if (!isRecord(ref) || typeof ref['hash'] !== 'string') throw new Error('bad_base')
    if (!Object.hasOwn(base.world.defs, ref['hash'])) throw new Error('bad_base')
  }
  return base
}

/** 原子写基础世界文件；`world_rev` 现算，不信调用方。 */
export function writeBase(
  file: string,
  payload: { snapshot: { seq: number; hash: Hash }; world: World; audits: BaseAuditRef[] },
): void {
  const base: BaseFile = {
    v: BASE_VERSION,
    snapshot: payload.snapshot,
    worldRev: worldRev(payload.world),
    world: payload.world,
    audits: payload.audits,
  }
  writeFileAtomic(file, JSON.stringify(base))
}
