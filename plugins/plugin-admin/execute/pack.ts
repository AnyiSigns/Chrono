// 候选源码树 → 世界写计划的纯构造：blob / tree / commit 三层 def 与宿主入世（planPack）
// 逐字节同构，write 计划才可能与 validate 的 result_hash 对上。
// 形状以 kernel §四 为准：blob = `{body}`（非文本加 `enc:'base64'`）；tree = `{body:{entries}}`；
// commit = `{body:{tree, meta:{name,version}}}`；批内用 `{"$n":k}` 指向更早的 put（规矩 A）。
// 排除口径与宿主一致：通用排除 node_modules / .git + 候选包内 `.worldignore` 声明项。

import { H } from './hash.ts'
import { createHash } from 'node:crypto'
import { isRecord } from './plan.ts'
import { ToolError } from './types.ts'
import type { Json, Rec } from './types.ts'

const EXCLUDED = new Set(['node_modules', '.git'])
const WORLDIGNORE_FILE = '.worldignore'
const MATERIALIZE_MARKER = '.chrono-materialized'

/**
 * `schema` 省略 / 空串时的最小默认 schema def body（与宿主入世默认同源，`docs/plugins.md` §二）。
 * 本包不得 import 宿主，故此处复刻同一常量；两处必须保持一致。
 */
const DEFAULT_SCHEMA_BODY: Json = { type: 'object' }

interface FileNode {
  kind: 'file'
  bytes: Buffer
}

interface DirNode {
  kind: 'dir'
  children: Map<string, FileNode | DirNode>
}

export interface CandidateDecl {
  identity: string
  /** 包内 schema 相对路径；省略 / 空串为 `null`（零 schema，入世时用宿主默认体）。 */
  schema: string | null
  pins: Record<string, string>
  version: string
}

export interface PackOps {
  ops: Json[]
  rootTreeIndex: number
  commitIndex: number
  schemaIndex: number
  commitHash: string
  fileCount: number
  /** 待落 CAS 的源码字节（按 sha256 去重）；调用方在返回写计划前经 `host.blob.put` 落盘。 */
  blobs: { sha256: string; bytes: Buffer }[]
}

/** 候选文件值：文本字符串，或 `{text}` / `{base64}` 显式形态（base64 只收规范编码）。 */
export function decodeFile(value: Json | undefined): Buffer | null {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (!isRecord(value)) return null
  const hasText = typeof value['text'] === 'string'
  const hasBase64 = typeof value['base64'] === 'string'
  if (hasText && hasBase64) return null
  if (hasText) return Buffer.from(value['text'] as string, 'utf8')
  if (hasBase64) {
    const base64 = value['base64'] as string
    const decoded = Buffer.from(base64, 'base64')
    return decoded.toString('base64') === base64 ? decoded : null
  }
  return null
}

/** 相对路径拆段；空段 / `.` 丢弃，`..` 非法 → null。 */
function pathSegments(relPath: string): string[] | null {
  const segments = relPath.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) return null
  return segments
}

function parseWorldignore(text: string): string[][] {
  const patterns: string[][] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const segments = pathSegments(trimmed)
    if (segments !== null && segments.length > 0) patterns.push(segments)
  }
  return patterns
}

function isIgnored(relSegments: string[], patterns: string[][]): boolean {
  return patterns.some(
    (pattern) =>
      pattern.length <= relSegments.length &&
      pattern.every((segment, index) => relSegments[index] === segment),
  )
}

/** 读候选包内某文本文件（经字节解码；非文本 / 缺失 → null）。 */
export function readTextFile(files: Rec, path: string): string | null {
  const bytes = decodeFile(files[path])
  return bytes === null ? null : bytes.toString('utf8')
}

/** 候选树规模：文件数 + 解码后总字节（供大小门禁；非法值不计）。 */
export function measureFiles(files: Rec): { fileCount: number; totalBytes: number } {
  let fileCount = 0
  let totalBytes = 0
  for (const value of Object.values(files)) {
    const bytes = decodeFile(value)
    if (bytes === null) continue
    fileCount += 1
    totalBytes += bytes.length
  }
  return { fileCount, totalBytes }
}

/**
 * 候选树规范化哈希（③ 缓存键）：对「路径 → 解码后字节的规范 base64」做内核口径 `H`。
 * 同一字节内容的不同入参形态（字符串 / `{text}` / `{base64}`）得到同一个键。
 */
export function candidateKey(files: Rec): string {
  const normalized: Rec = {}
  for (const path of Object.keys(files).sort()) {
    const bytes = decodeFile(files[path])
    normalized[path] = bytes === null ? null : bytes.toString('base64')
  }
  return H(normalized)
}

/** 解析候选 `plugin.json`（身份 / schema 路径 / pins）与 `package.json` 版本。 */
export function parseCandidateDecl(files: Rec): CandidateDecl {
  const pluginText = readTextFile(files, 'plugin.json')
  if (pluginText === null) throw new ToolError('bad_candidate', 'plugin.json missing')
  let parsed: Json
  try {
    parsed = JSON.parse(pluginText) as Json
  } catch {
    throw new ToolError('bad_candidate', 'plugin.json invalid JSON')
  }
  if (!isRecord(parsed)) throw new ToolError('bad_candidate', 'plugin.json not an object')
  const identity = parsed['identity']
  const rawSchema = parsed['schema']
  if (typeof identity !== 'string' || identity.length === 0) {
    throw new ToolError('bad_candidate', 'plugin.json identity missing')
  }
  // `schema` 可省略 / 空串（零 schema）；显式非字符串（含 null）仍拒——与宿主同口径。
  if (rawSchema !== undefined && typeof rawSchema !== 'string') {
    throw new ToolError('bad_candidate', 'plugin.json schema must be a string')
  }
  const schema = typeof rawSchema === 'string' && rawSchema.length > 0 ? rawSchema : null
  const pins: Record<string, string> = {}
  if (isRecord(parsed['pins'])) {
    for (const [name, value] of Object.entries(parsed['pins'] as Rec)) {
      if (typeof value === 'string') pins[name] = value
    }
  }
  let version = ''
  const packageText = readTextFile(files, 'package.json')
  if (packageText !== null) {
    try {
      const pkg = JSON.parse(packageText) as Json
      if (isRecord(pkg) && typeof pkg['version'] === 'string') version = pkg['version']
    } catch {
      version = ''
    }
  }
  return { identity, schema, pins, version }
}

/** 按候选文件表建目录树；不安全路径 / 坏文件值 → `bad_candidate`。 */
function buildTree(files: Rec): DirNode {
  const worldignoreText = readTextFile(files, WORLDIGNORE_FILE)
  const patterns = worldignoreText === null ? [] : parseWorldignore(worldignoreText)
  const root: DirNode = { kind: 'dir', children: new Map() }
  for (const [path, value] of Object.entries(files)) {
    const segments = pathSegments(path)
    if (segments === null || segments.length === 0) {
      throw new ToolError('bad_candidate', `unsafe path: ${path}`)
    }
    if (segments.some((segment) => EXCLUDED.has(segment))) continue
    if (
      segments.includes(WORLDIGNORE_FILE) ||
      segments.includes(MATERIALIZE_MARKER) ||
      isIgnored(segments, patterns)
    ) {
      continue
    }
    const bytes = decodeFile(value)
    if (bytes === null) throw new ToolError('bad_candidate', `bad file: ${path}`)
    let dir = root
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i]
      const next = dir.children.get(name)
      if (next === undefined) {
        const created: DirNode = { kind: 'dir', children: new Map() }
        dir.children.set(name, created)
        dir = created
      } else if (next.kind === 'dir') {
        dir = next
      } else {
        throw new ToolError('bad_candidate', `path conflict: ${path}`)
      }
    }
    const leaf = segments[segments.length - 1]
    if (dir.children.has(leaf)) throw new ToolError('bad_candidate', `path conflict: ${path}`)
    dir.children.set(leaf, { kind: 'file', bytes })
  }
  return root
}

interface DirPack {
  index: number
  hash: string
  fileCount: number
}

/** 原始字节摘要：sha256 十六进制（与宿主 `blobSha256` 同口径），兼作 CAS 文件名。 */
function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 递归打包：子项先（名字升序），目录 tree 在子项之后入 ops——与宿主 packSourceDir 同序。
 * 文件 blob 用**指针形态** `{kind:'blob',sha256,size}`（与宿主入世同口径），字节按 sha256 去重收集待落 CAS。 */
function packDir(node: DirNode, ops: Json[], blobs: Map<string, Buffer>): DirPack {
  const entries: Json[] = []
  const placeholderEntries: Json[] = []
  let fileCount = 0
  for (const name of [...node.children.keys()].sort()) {
    const child = node.children.get(name)
    if (child === undefined) continue
    if (child.kind === 'dir') {
      const packed = packDir(child, ops, blobs)
      entries.push({ name, mode: 'dir', hash: packed.hash })
      placeholderEntries.push({ name, mode: 'dir', hash: { $n: packed.index } })
      fileCount += packed.fileCount
    } else {
      const sha256 = sha256Bytes(child.bytes)
      if (!blobs.has(sha256)) blobs.set(sha256, child.bytes)
      const def: Json = { body: { kind: 'blob', sha256, size: child.bytes.length } }
      const hash = H(def)
      const index = ops.length
      ops.push({ op: 'put', args: def })
      entries.push({ name, mode: 'file', hash })
      placeholderEntries.push({ name, mode: 'file', hash: { $n: index } })
      fileCount += 1
    }
  }
  const hash = H({ body: { entries } })
  const index = ops.length
  ops.push({ op: 'put', args: { body: { entries: placeholderEntries } } })
  return { index, hash, fileCount }
}

/**
 * 构造 put(blob)×n + put(tree) + put(commit) + put(schema) 子操作序列与真实 commit 哈希。
 * `identity` 必须等于候选 `plugin.json.identity`（调用方先校验）。
 */
export function buildPackOps(files: Rec, identity: string, decl: CandidateDecl): PackOps {
  const root = buildTree(files)
  const ops: Json[] = []
  const blobs = new Map<string, Buffer>()
  const packed = packDir(root, ops, blobs)
  const meta: Rec = { name: identity, version: decl.version }
  const commitHash = H({ body: { tree: packed.hash, meta } })
  const commitIndex = ops.length
  ops.push({ op: 'put', args: { body: { tree: { $n: packed.index }, meta } } })

  const schemaIndex = ops.length
  if (decl.schema === null) {
    // 零 schema：不读文件，机械用宿主同源默认体，仍 put 成 def 供身份引用
    ops.push({ op: 'put', args: { body: DEFAULT_SCHEMA_BODY } })
  } else {
    const schemaText = readTextFile(files, decl.schema)
    if (schemaText === null) throw new ToolError('bad_candidate', `schema missing: ${decl.schema}`)
    let schemaJson: Json
    try {
      schemaJson = JSON.parse(schemaText) as Json
    } catch {
      throw new ToolError('bad_candidate', `schema invalid JSON: ${decl.schema}`)
    }
    ops.push({ op: 'put', args: { body: schemaJson } })
  }

  return {
    ops,
    rootTreeIndex: packed.index,
    commitIndex,
    schemaIndex,
    commitHash,
    fileCount: packed.fileCount,
    blobs: [...blobs.entries()].map(([sha256, bytes]) => ({ sha256, bytes })),
  }
}
