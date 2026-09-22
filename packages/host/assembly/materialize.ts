// 物化：世代 commit → 源码树 → 工作副本（③ 可重算），与入世打包互逆。
// 内容定址：同一 commit 只写一次；先写暂存目录再原子改名，永不暴露半棵树。
// 复用前校验宿主标记（防半棵树 / 被篡改目录）；标记不属于源码树。
//
// 源码字节有两种 blob 形态：inline（旧世界，body 为字符串）与 pointer（body 为内容引用）。
// pointer 走 CAS：优先硬链接共享同一 inode（一次换代的增量成本 ∝ 实际改动字节），
// 跨卷 / 无权限 / 链接数上限等场景回退复制；物化出的源码文件置只读，防就地写污染 CAS。

import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { blobFile, isBlobPointer } from '../blobs.ts'
import { MATERIALIZE_MARKER } from './source.ts'
import type { BlobPointer } from '../blobs.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

/** 硬链接接缝：默认 `linkSync`；测试注入以模拟跨卷 / 无权限等失败。 */
export type BlobLinker = (source: string, dest: string) => void

export interface MaterializeOptions {
  /** 源码 CAS 目录；pointer 形态必需，inline 旧世界可省。 */
  blobsDir?: string
  linker?: BlobLinker
}

/** 硬链接不可用时回退复制的错误码：跨卷、无权限、链接数上限、文件系统不支持。 */
const LINK_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'EXDEV',
  'EPERM',
  'EACCES',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
])

interface MaterializeContext {
  blobsDir: string | undefined
  linker: BlobLinker
}

/** 物化一个世代到 `<materializedDir>/<commitHash>`；返回根目录，失败返回 null。 */
export function materializeCommit(
  world: World,
  commitHash: Hash,
  materializedDir: string,
  options: MaterializeOptions = {},
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

  const context: MaterializeContext = {
    blobsDir: options.blobsDir,
    linker: options.linker ?? linkSync,
  }
  mkdirSync(materializedDir, { recursive: true })
  const staging = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    writeTree(world, tree, staging, context)
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

function writeTree(world: World, treeHash: Hash, dir: string, context: MaterializeContext): void {
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
      writeTree(world, hash, abs, context)
      continue
    }
    if (mode !== 'file') throw new Error('bad_tree')
    writeBlob(world.defs[hash] as { body?: Json; enc?: Json } | undefined, abs, context)
  }
}

/** 写一个文件 blob：pointer 走 CAS 共享，inline 维持逐字节写（旧世界兼容）。 */
function writeBlob(
  blob: { body?: Json; enc?: Json } | undefined,
  dest: string,
  context: MaterializeContext,
): void {
  const body = blob?.body
  if (isBlobPointer(body)) {
    materializePointer(body, dest, context)
    return
  }
  if (typeof body !== 'string') throw new Error('bad_blob')
  if (blob?.enc === 'base64') writeFileSync(dest, Buffer.from(body, 'base64'))
  else writeFileSync(dest, body)
}

/** pointer 物化：CAS 缺失 / 截断即失败（不产出半截源码），成功即共享 inode 并置只读。 */
function materializePointer(pointer: BlobPointer, dest: string, context: MaterializeContext): void {
  if (context.blobsDir === undefined) throw new Error('blob_missing')
  const source = blobFile(context.blobsDir, pointer.sha256)
  if (source === null) throw new Error('bad_blob')
  if (!existsSync(source)) throw new Error('blob_missing')
  // size 对照防截断：哈希校验留给读入内存的路径（物化不读字节，否则失去共享的意义）
  if (statSync(source).size !== pointer.size) throw new Error('bad_blob')
  linkOrCopy(source, dest, context.linker)
  setReadOnly(dest)
}

/** 硬链接优先；不支持时回退复制（不省空间但正确）。非回退类错误照常抛出。 */
function linkOrCopy(source: string, dest: string, linker: BlobLinker): void {
  try {
    linker(source, dest)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === undefined || !LINK_FALLBACK_CODES.has(code)) throw err
  }
  copyFileSync(source, dest)
}

/** 源码文件置只读：POSIX `0444`；Windows 上 Node 的 chmod 只映射写位，效果等同清写位。 */
function setReadOnly(file: string): void {
  try {
    chmodSync(file, 0o444)
  } catch {
    // 只读置位是共享安全的前提，但文件系统不支持时不影响物化结果本身
  }
}
