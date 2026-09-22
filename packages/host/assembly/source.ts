// 插件包源码树 → defs 的纯打包：文件 → blob，目录 → tree（自底向上）。
// 排除 = 通用排除（node_modules / .git）+ 插件 `.worldignore` 声明项；宿主不内置语言 / 构建名字。
// 同时给出占位符形式的批内 ops 与真实哈希（供去重 / 身份引用），两者内容同构。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { H } from '../../kernel/index.ts'
import { blobPointerOf, blobSha256 } from '../blobs.ts'
import type { Json } from '../../kernel/index.ts'

/** 通用排除：依赖（宿主侧 ③）与版本库元数据——宿主只内置这两个名字。 */
export const SOURCE_EXCLUDED_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git'])

/** 入世排除表文件名；自身永不进源码树。 */
export const WORLDIGNORE_FILE = '.worldignore'

/** 物化目录的宿主标记文件名：标记不属于源码树，打包时恒排除。 */
export const MATERIALIZE_MARKER = '.chrono-materialized'

export interface PackedBlob {
  sha256: string
  bytes: Buffer
}

export interface PackedSource {
  ops: Json[]
  rootTreeIndex: number
  rootTreeHash: string
  fileCount: number
  /** 待落 CAS 的原始字节（按 sha256 去重）；dry-run 由调用方决定是否落盘。 */
  blobs: PackedBlob[]
}

export type WorldignoreRead = { ok: true; patterns: string[][] } | { ok: false }

interface DirResult {
  index: number
  hash: string
  fileCount: number
}

interface TreeEntry {
  name: string
  mode: 'file' | 'dir'
  hash: string
}

/** 把相对路径拆成路径段；空段与 `.` 丢弃，`..` 视为非法（返回 null）。 */
export function pathSegments(relPath: string): string[] | null {
  const segments = relPath.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) return null
  return segments
}

/** 解析 `.worldignore` 文本：`#` 注释 / 空行忽略，其余每行一个相对路径。 */
export function parseWorldignoreText(text: string): WorldignoreRead {
  const patterns: string[][] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const segments = pathSegments(trimmed)
    if (segments === null) return { ok: false }
    if (segments.length === 0) continue
    patterns.push(segments)
  }
  return { ok: true, patterns }
}

/** 读包内 `.worldignore`；文件不存在视为空表。 */
export function readWorldignore(pkgRoot: string): WorldignoreRead {
  const file = join(pkgRoot, WORLDIGNORE_FILE)
  if (!existsSync(file)) return { ok: true, patterns: [] }
  try {
    return parseWorldignoreText(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false }
  }
}

/** 路径段前缀匹配：pattern 的每一段都对上 relPath 的同位置段即命中（`test` 不误伤 `test.js`）。 */
export function isIgnored(relSegments: string[], patterns: string[][]): boolean {
  return patterns.some(
    (pattern) =>
      pattern.length <= relSegments.length &&
      pattern.every((segment, index) => relSegments[index] === segment),
  )
}

/** 打包一个目录：返回批内 put 子操作（文件在前、目录在后）与根 tree 的真实哈希。 */
export function packSourceDir(absDir: string, patterns: string[][] = []): PackedSource {
  const ops: Json[] = []
  // 同内容去重：同一份字节在包内出现多次只回传一次，落 CAS 幂等且不重复搬运
  const blobs = new Map<string, Buffer>()
  const root = packDir(absDir, ops, [], patterns, blobs)
  return {
    ops,
    rootTreeIndex: root.index,
    rootTreeHash: root.hash,
    fileCount: root.fileCount,
    blobs: [...blobs.entries()].map(([sha256, bytes]) => ({ sha256, bytes })),
  }
}

function packDir(
  dir: string,
  ops: Json[],
  rel: string[],
  patterns: string[][],
  blobs: Map<string, Buffer>,
): DirResult {
  const entries: TreeEntry[] = []
  const placeholderEntries: Json[] = []
  let fileCount = 0
  const dirents = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !SOURCE_EXCLUDED_NAMES.has(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const dirent of dirents) {
    if (dirent.name === WORLDIGNORE_FILE || dirent.name === MATERIALIZE_MARKER) continue
    const relPath = [...rel, dirent.name]
    if (isIgnored(relPath, patterns)) continue
    const abs = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      const child = packDir(abs, ops, relPath, patterns, blobs)
      entries.push({ name: dirent.name, mode: 'dir', hash: child.hash })
      placeholderEntries.push({ name: dirent.name, mode: 'dir', hash: { $n: child.index } })
      fileCount += child.fileCount
    } else if (dirent.isFile()) {
      // 字节本体外迁 CAS，链上只留 pointer def（摘要 + 长度）；文本与二进制同形，不再 base64
      const raw = readFileSync(abs)
      const sha256 = blobSha256(raw)
      const def = { body: blobPointerOf(sha256, raw.length) }
      const hash = H(def as unknown as Json)
      const index = ops.length
      ops.push({ op: 'put', args: def as unknown as Json })
      if (!blobs.has(sha256)) blobs.set(sha256, raw)
      entries.push({ name: dirent.name, mode: 'file', hash })
      placeholderEntries.push({ name: dirent.name, mode: 'file', hash: { $n: index } })
      fileCount += 1
    }
  }
  const hash = H({ body: { entries } } as unknown as Json)
  const index = ops.length
  ops.push({ op: 'put', args: { body: { entries: placeholderEntries } } })
  return { index, hash, fileCount }
}
