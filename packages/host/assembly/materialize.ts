// 物化：世代 commit → 源码树 → 工作副本（③ 可重算），与入世打包互逆。
// 内容定址：同一 commit 只写一次；先写暂存目录再原子改名，永不暴露半棵树。
// 复用前校验宿主标记（防半棵树 / 被篡改目录）；标记不属于源码树。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MATERIALIZE_MARKER } from './source.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

/** 物化一个世代到 `<materializedDir>/<commitHash>`；返回根目录，失败返回 null。 */
export function materializeCommit(
  world: World,
  commitHash: Hash,
  materializedDir: string,
): string | null {
  const commit = world.defs[commitHash]
  const tree = (commit?.body as { tree?: Json } | undefined)?.tree
  if (typeof tree !== 'string') return null
  const target = join(materializedDir, commitHash)
  if (existsSync(target)) {
    if (readMarker(target) === commitHash) return target
    // 标记缺失 / 不符：目录不可信，整目录重物化
    rmSync(target, { recursive: true, force: true })
  }

  mkdirSync(materializedDir, { recursive: true })
  const staging = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    writeTree(world, tree, staging)
    writeFileSync(join(staging, MATERIALIZE_MARKER), commitHash)
    renameSync(staging, target)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (existsSync(target)) return target
    throw err
  }
  return target
}

function readMarker(dir: string): string | null {
  try {
    return readFileSync(join(dir, MATERIALIZE_MARKER), 'utf8').trim()
  } catch {
    return null
  }
}

function writeTree(world: World, treeHash: Hash, dir: string): void {
  const entries = (world.defs[treeHash]?.body as { entries?: Json } | undefined)?.entries
  if (!Array.isArray(entries)) throw new Error('bad_tree')
  mkdirSync(dir, { recursive: true })
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('bad_tree')
    }
    const record = entry as { [k: string]: Json }
    const name = record['name']
    const mode = record['mode']
    const hash = record['hash']
    if (typeof name !== 'string' || name.length === 0) throw new Error('bad_tree')
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new Error('bad_tree')
    }
    if (typeof hash !== 'string') throw new Error('bad_tree')
    const abs = join(dir, name)
    if (mode === 'dir') {
      writeTree(world, hash, abs)
      continue
    }
    if (mode !== 'file') throw new Error('bad_tree')
    const blob = world.defs[hash] as { body?: Json; enc?: Json } | undefined
    const body = blob?.body
    if (typeof body !== 'string') throw new Error('bad_blob')
    if (blob?.enc === 'base64') writeFileSync(abs, Buffer.from(body, 'base64'))
    else writeFileSync(abs, body)
  }
}
