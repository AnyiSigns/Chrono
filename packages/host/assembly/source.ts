// 插件包源码树 → defs 的纯打包：文件 → blob，目录 → tree（自底向上）。
// 同时给出占位符形式的批内 ops 与真实哈希（供去重 / 身份引用），两者内容同构。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { H } from '../../kernel/index.ts'
import type { Json } from '../../kernel/index.ts'

/** 不进源码树的目录 / 文件：依赖与构建产物属宿主侧可重算本体。 */
const EXCLUDED = new Set(['node_modules', '.git', 'dist', 'build', '.DS_Store'])

export interface PackedSource {
  ops: Json[]
  rootTreeIndex: number
  rootTreeHash: string
  fileCount: number
}

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

/** 打包一个目录：返回批内 put 子操作（文件在前、目录在后）与根 tree 的真实哈希。 */
export function packSourceDir(absDir: string): PackedSource {
  const ops: Json[] = []
  const root = packDir(absDir, ops)
  return { ops, rootTreeIndex: root.index, rootTreeHash: root.hash, fileCount: root.fileCount }
}

function packDir(dir: string, ops: Json[]): DirResult {
  const entries: TreeEntry[] = []
  const placeholderEntries: Json[] = []
  let fileCount = 0
  const dirents = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !EXCLUDED.has(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const dirent of dirents) {
    const abs = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      const child = packDir(abs, ops)
      entries.push({ name: dirent.name, mode: 'dir', hash: child.hash })
      placeholderEntries.push({ name: dirent.name, mode: 'dir', hash: { $n: child.index } })
      fileCount += child.fileCount
    } else if (dirent.isFile()) {
      const def = { body: readFileSync(abs, 'utf8') }
      const hash = H(def as unknown as Json)
      const index = ops.length
      ops.push({ op: 'put', args: def as unknown as Json })
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
