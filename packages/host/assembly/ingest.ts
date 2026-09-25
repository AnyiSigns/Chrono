// 入世计划：把插件包源码树变成一条原子 batch 的子操作序列（纯计划，不落账）。
// 计划由调用方（离线 seed）交给世界写口提交；assembly 只读世界、不写链。
// 排除与 term `$ref` 替换都在本层做：宿主只做机械解析，不认识语义。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { H } from '../../kernel/index.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { hostPaths } from '../paths.ts'
import { isSafeIdentityName } from './identity-name.ts'
import { validateArgsSchema } from './args-schema.ts'
import {
  DEFAULT_SCHEMA_BODY,
  isCodeGen,
  latestCodeGen,
  parsePluginDecl,
  readPluginDeclOfGen,
  termDefOf,
} from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { isIgnored, packSourceDir, pathSegments, readWorldignore } from './source.ts'
import type { PackedBlob } from './source.ts'
import { collectRefs, normalizeRefPath, replaceTermRefs, termTopoOrder } from './term-refs.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

/** `state/plugins.json` 的一项：有 path 按路径解析，无 path 走 Node 解析。 */
export interface PluginEntry {
  name: string
  path?: string
}

/** 读 `state/plugins.json`；缺文件即空清单；形态非法抛 `bad_plugins_manifest`。 */
export function readPluginManifest(root: string): PluginEntry[] {
  const file = hostPaths(root).pluginsFile
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('bad_plugins_manifest')
  return parsed.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('bad_plugins_manifest')
    const record = item as { name?: unknown; path?: unknown }
    if (typeof record.name !== 'string' || record.name.length === 0) {
      throw new Error('bad_plugins_manifest')
    }
    return record.path === undefined
      ? { name: record.name }
      : { name: record.name, path: String(record.path) }
  })
}

export interface IngestPlan {
  identity: string
  ops: Json[]
  isNewIdentity: boolean
  commitHash: Hash
  schemaHash: Hash
  /** 同源码已 active：不产生任何子操作。 */
  unchanged: boolean
  /** 待落 CAS 的源码字节（按 sha256 去重）；调用方在 `commit` 前落盘，dry-run 不落。 */
  blobs: PackedBlob[]
}

export type IngestResult = { ok: true; plan: IngestPlan } | { ok: false; reasons: string[] }

/** 锁文件属契约必需文件：存在即不可被 `.worldignore` 排除（npm 信封 + 常见生态锁名）。 */
const LOCK_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
]

/**
 * 受保护身份（保护名单住宿主侧、不进世界，故连代码换代也改不动）：新世代删除对它们的 `pins` 引用即整批拒。
 * 理由：可见性过滤是黑名单，攻击面在依赖关系——agent 可写一个不 pin `sandbox` 的 `tool-fs` 让强制失效；
 * 委托持久化同理，删掉对存储服务的 `pins` 会让写入静默失效。这是纯机械的「旧世代有、新世代没了」比对，宿主不认识业务。
 * 覆盖范围与既有受保护身份同：只覆盖入世（`seed` / `pack` / `validate_package`），裸运行期顶层 `add_gen` 不经入世门禁。
 */
const PROTECTED_PIN_IDENTITIES: ReadonlySet<string> = new Set([
  'sandbox',
  'guard',
  'secrets',
  'approval',
  'storage-sql',
  'storage-kv',
])

/**
 * 跨代比对 `pins`：最近代码世代引用了某受保护身份、新声明不再引用 → 删了保护边。
 * 按被依赖身份名比对（`decl.pins` 的值即身份名），不涉及解析后的哈希。
 * 不依赖 `active`：retired 身份重入世同样按最近代码世代比对，否则「退役→重入世」可绕过保护。
 * 身份不存在 / 无代码世代 → 无从比对，放行；有代码世代但声明读不出 → fail-closed 拒。
 */
function removedProtectedPin(
  world: World,
  identity: string,
  decl: PluginDecl,
  blobsDir: string | undefined,
): boolean {
  const record = Object.hasOwn(world.ids, identity) ? world.ids[identity] : undefined
  if (record === undefined) return false
  let codeGen: Gen | null = null
  for (let i = record.gens.length - 1; i >= 0; i--) {
    if (isCodeGen(world, record.gens[i])) {
      codeGen = record.gens[i]
      break
    }
  }
  if (codeGen === null) return false
  const previous = readPluginDeclOfGen(world, codeGen, blobsDir)
  if (previous === null) return true
  const nextPins = new Set(Object.values(decl.pins))
  for (const depId of Object.values(previous.decl.pins)) {
    if (PROTECTED_PIN_IDENTITIES.has(depId) && !nextPins.has(depId)) return true
  }
  return false
}

/** 解析插件包根目录：path 优先，其次 Node 解析；都找不到返回 null。 */
function resolvePackageRoot(entry: PluginEntry, root: string): string | null {
  if (entry.path !== undefined && entry.path.length > 0) {
    const abs = resolve(root, entry.path)
    return existsSync(join(abs, 'plugin.json')) ? abs : null
  }
  const require = createRequire(join(root, 'index.js'))
  for (const spec of [`${entry.name}/plugin.json`, entry.name]) {
    try {
      const resolved = require.resolve(spec)
      const dir = spec.endsWith('plugin.json') ? dirname(resolved) : findPackageDir(resolved)
      if (dir !== null && existsSync(join(dir, 'plugin.json'))) return dir
    } catch {
      // 该候选解析不到：试下一个
    }
  }
  return null
}

function findPackageDir(startFile: string): string | null {
  let dir = dirname(startFile)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readJsonFile(abs: string): Json | undefined {
  if (!existsSync(abs)) return undefined
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as Json
  } catch {
    return undefined
  }
}

function readPackageVersion(pkgRoot: string): string {
  const pkg = readJsonFile(join(pkgRoot, 'package.json'))
  if (typeof pkg === 'object' && pkg !== null && !Array.isArray(pkg)) {
    const version = (pkg as { [k: string]: Json })['version']
    if (typeof version === 'string') return version
  }
  return ''
}

function collectJsonFiles(absDir: string, rel: string, out: string[]): void {
  if (!existsSync(absDir)) return
  for (const dirent of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`
    if (dirent.isDirectory()) collectJsonFiles(join(absDir, dirent.name), relPath, out)
    else if (dirent.isFile() && dirent.name.endsWith('.json')) out.push(relPath)
  }
}

/** 声明中的包内路径必须是安全相对路径：禁 `..` 段、绝对路径、盘符与反斜杠。 */
function isSafePackagePath(path: string): boolean {
  if (path.length === 0) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (path.includes('\\')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  const segments = path.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  return segments.length > 0 && !segments.some((segment) => segment === '..')
}

/** 找第一个逃逸包根的声明路径（schema / 命令入口 / 参数 schema / members）；无则 null。 */
function unsafeDeclaredPath(decl: PluginDecl): string | null {
  const candidates: string[] = decl.schema === null ? [] : [decl.schema]
  for (const command of decl.commands) {
    candidates.push(command.entry)
    if (command.argsSchema !== undefined) candidates.push(command.argsSchema)
  }
  for (const member of decl.members) candidates.push(member.path)
  return candidates.find((candidate) => !isSafePackagePath(candidate)) ?? null
}

/** 契约层引用的包内文件：命中 `.worldignore` 即整批拒绝。 */
function ignoredRequiredPath(
  pkgRoot: string,
  decl: PluginDecl,
  patterns: string[][],
): string | null {
  const candidates = new Set<string>(['plugin.json', 'package.json', 'README.md'])
  if (decl.schema !== null) candidates.add(decl.schema)
  for (const lock of LOCK_FILES) {
    if (existsSync(join(pkgRoot, lock))) candidates.add(lock)
  }
  for (const command of decl.commands) {
    candidates.add(command.entry)
    if (command.argsSchema !== undefined) candidates.add(command.argsSchema)
  }
  for (const member of decl.members) candidates.add(member.path)
  for (const candidate of candidates) {
    const segments = pathSegments(candidate)
    if (segments === null) continue
    if (isIgnored(segments, patterns)) return candidate
  }
  return null
}

/**
 * 包内 term 入世：先按 `$ref` 图拓扑序（callee 先），逐个替换占位符成 callee def 哈希。
 * 引用包外 / 不存在的成员 → `bad_term_ref`；成环 → `term_cycle`；两者都整包拒。
 */
function planTerms(
  pkgRoot: string,
  decl: PluginDecl,
  commitHash: Hash,
  ops: Json[],
): { ok: true } | { ok: false; reasons: string[] } {
  const paths = new Set<string>()
  const collected: string[] = []
  collectJsonFiles(join(pkgRoot, 'terms'), 'terms', collected)
  // 统一规范化（`./`、重复 `/` 等），否则引用侧规范化后会对不上索引
  for (const raw of [...collected, ...decl.commands.map((command) => command.entry)]) {
    const normalized = normalizeRefPath(raw)
    if (normalized === null) return { ok: false, reasons: [`missing_entry:${raw}`] }
    paths.add(normalized)
  }
  const all = [...paths].sort()

  const asts = new Map<string, Json>()
  for (const path of all) {
    const ast = readJsonFile(join(pkgRoot, path))
    if (ast === undefined) return { ok: false, reasons: [`missing_entry:${path}`] }
    asts.set(path, ast)
  }

  const refs = new Map<string, string[]>()
  for (const path of all) {
    const found: string[] = []
    collectRefs(asts.get(path) as Json, found)
    const normalized: string[] = []
    for (const ref of found) {
      const target = normalizeRefPath(ref)
      if (target === null || !paths.has(target)) return { ok: false, reasons: ['bad_term_ref'] }
      normalized.push(target)
    }
    refs.set(path, normalized)
  }

  const order = termTopoOrder(all, (path) => refs.get(path) ?? [])
  if (order === null) return { ok: false, reasons: ['term_cycle'] }

  const hashes = new Map<string, Hash>()
  for (const path of order) {
    const replaced = replaceTermRefs(asts.get(path) as Json, (ref) => hashes.get(ref) ?? null)
    if (!replaced.ok) return { ok: false, reasons: ['bad_term_ref'] }
    const def = termDefOf(replaced.value, commitHash)
    hashes.set(path, H(def as unknown as Json))
    ops.push({ op: 'put', args: def as unknown as Json })
  }
  return { ok: true }
}

function planIdentity(
  world: World,
  identity: string,
  pins: Record<string, Hash>,
  ops: Json[],
  commitIndex: number,
  schemaIndex: number,
  commitHash: Hash,
  schemaHash: Hash,
  blobs: PackedBlob[],
): IngestPlan {
  const isNewIdentity = !Object.hasOwn(world.ids, identity)
  if (isNewIdentity) {
    ops.push({ op: 'add_identity', args: { id: identity, schema: { $n: schemaIndex } } })
  }
  ops.push({
    op: 'add_gen',
    args: { id: identity, payload: { $n: commitIndex }, pins, sig: { $n: commitIndex } },
  })
  return { identity, ops, isNewIdentity, commitHash, schemaHash, unchanged: false, blobs }
}

/**
 * 已解析包根的入世核心：`identity` 缺省取 `plugin.json.identity`（seed 路径）；
 * `pack` 显式给出身份名时必须与包内声明**一致**（命名即契约，单源），不一致即拒。
 */
function planIngestAtRoot(
  world: World,
  pkgRoot: string,
  identityOverride: string | undefined,
  blobsDir: string | undefined,
): IngestResult {
  const rawDecl = readJsonFile(join(pkgRoot, 'plugin.json'))
  if (rawDecl === undefined) return { ok: false, reasons: ['missing_plugin_json'] }
  const parsed = parsePluginDecl(rawDecl)
  if (!parsed.ok) return parsed
  const decl = parsed.decl
  if (identityOverride !== undefined && identityOverride !== decl.identity) {
    return { ok: false, reasons: ['identity_mismatch'] }
  }
  const identity = identityOverride ?? decl.identity
  if (!isSafeIdentityName(identity)) return { ok: false, reasons: ['bad_plugin_decl'] }
  if (unsafeDeclaredPath(decl) !== null) return { ok: false, reasons: ['bad_plugin_decl'] }

  if (removedProtectedPin(world, identity, decl, blobsDir)) {
    return { ok: false, reasons: ['protected_pin_removed'] }
  }

  const worldignore = readWorldignore(pkgRoot)
  if (!worldignore.ok) return { ok: false, reasons: ['bad_worldignore'] }
  if (ignoredRequiredPath(pkgRoot, decl, worldignore.patterns) !== null) {
    return { ok: false, reasons: ['bad_worldignore'] }
  }

  const pins: Record<string, Hash> = {}
  for (const [name, depId] of Object.entries(decl.pins)) {
    // 保留能力类 `host`：保留字面量，不查世界、不报 unresolved_pin
    if (depId === HOST_CAPABILITY) {
      pins[name] = HOST_CAPABILITY
      continue
    }
    const dep = world.ids[depId]
    if (!dep || dep.active === null) return { ok: false, reasons: ['unresolved_pin'] }
    pins[name] = dep.active
  }

  const packed = packSourceDir(pkgRoot, worldignore.patterns)
  const ops: Json[] = [...packed.ops]
  const meta = { name: identity, version: readPackageVersion(pkgRoot) }
  const commitHash = H({ body: { tree: packed.rootTreeHash, meta } } as unknown as Json)
  const commitIndex = ops.length
  ops.push({ op: 'put', args: { body: { tree: { $n: packed.rootTreeIndex }, meta } } })

  // `schema` 省略 / 空串：宿主机械提供最小默认体（零 schema 的 UI 插件），仍 put 成 def 供身份引用
  let schemaJson: Json
  if (decl.schema === null) {
    schemaJson = DEFAULT_SCHEMA_BODY
  } else {
    const read = readJsonFile(join(pkgRoot, decl.schema))
    if (read === undefined) return { ok: false, reasons: ['missing_schema'] }
    schemaJson = read
  }
  const schemaHash = H({ body: schemaJson } as unknown as Json)
  const schemaIndex = ops.length
  ops.push({ op: 'put', args: { body: schemaJson } })

  const terms = planTerms(pkgRoot, decl, commitHash, ops)
  if (!terms.ok) return { ok: false, reasons: terms.reasons }

  for (const command of decl.commands) {
    if (command.argsSchema === undefined) continue
    const schema = readJsonFile(join(pkgRoot, command.argsSchema))
    if (schema === undefined) {
      return { ok: false, reasons: [`missing_args_schema:${command.argsSchema}`] }
    }
    const dialect = validateArgsSchema(schema)
    if (!dialect.ok) {
      return { ok: false, reasons: [`bad_args_schema:${command.name}:${dialect.reason}`] }
    }
    ops.push({ op: 'put', args: { body: schema } })
  }

  const existing = Object.hasOwn(world.ids, identity) ? world.ids[identity] : undefined
  // G7 A1：包未变 = 「最近代码世代就是本包 commit」（active 可能已被数据世代占据）
  if (existing && latestCodeGen(world, identity)?.payload === commitHash) {
    return {
      ok: true,
      plan: {
        identity,
        ops: [],
        isNewIdentity: false,
        commitHash,
        schemaHash,
        unchanged: true,
        blobs: [],
      },
    }
  }
  return {
    ok: true,
    plan: planIdentity(
      world,
      identity,
      pins,
      ops,
      commitIndex,
      schemaIndex,
      commitHash,
      schemaHash,
      packed.blobs,
    ),
  }
}

/**
 * 解析一个清单项的投递包根目录（有 path 按路径、无 path 走 Node 解析）。
 * 供只读消费者（源码 watcher 解析要盯的目录）复用，保证与入世解析同一口径；解析不到返回 null。
 */
export function resolveEntryRoot(root: string, entry: PluginEntry): string | null {
  return resolvePackageRoot(entry, root)
}

/**
 * 解析一个插件包并构造入世 batch 计划；不改世界、不落账。
 * 读失败（文件在打包中途被删 / 目录消失 / 权限变化）按 `{ok:false,reasons}` 返回，
 * 交调用方走 `failed` 分支，而不是抛错被 watcher 归为自身故障。
 */
export function planIngest(world: World, root: string, entry: PluginEntry): IngestResult {
  try {
    const pkgRoot = resolvePackageRoot(entry, root)
    if (pkgRoot === null) return { ok: false, reasons: ['package_not_found'] }
    return planIngestAtRoot(world, pkgRoot, undefined, hostPaths(root).blobsDir)
  } catch {
    return { ok: false, reasons: ['source_read_failed'] }
  }
}

/** 名级依赖节点：清单项解析出的身份名与它 pin 的依赖身份名（`host` 保留能力除外）。 */
interface SeedNode {
  index: number
  identity: string
  deps: string[]
}

/** 读一个清单项的身份与依赖名；包 / 声明读不出时身份回落清单项名、依赖为空（不阻塞排序）。 */
function readSeedNode(root: string, entry: PluginEntry, index: number): SeedNode {
  const pkgRoot = resolvePackageRoot(entry, root)
  const rawDecl = pkgRoot === null ? undefined : readJsonFile(join(pkgRoot, 'plugin.json'))
  if (rawDecl === undefined) return { index, identity: entry.name, deps: [] }
  const parsed = parsePluginDecl(rawDecl)
  if (!parsed.ok) return { index, identity: entry.name, deps: [] }
  const deps = Object.values(parsed.decl.pins).filter((dep) => dep !== HOST_CAPABILITY)
  return { index, identity: parsed.decl.identity, deps }
}

/**
 * 入世排序（名级）：按 `plugin.json.pins` 把清单重排为「被依赖者先入世」，一次收敛。
 * 依赖身份此刻可能尚未入世（pin 解析发生在入世时），故只能按声明里的身份名建图，不查世界；
 * 图按「身份名 → 清单下标」解析，身份名与清单项名都参与，取先到者。
 * 引脚指向清单外 / 自身者不建边；清单内成环时环成员保持清单原序，由入世期按 `unresolved_pin` fail-closed 报出。
 */
export function orderEntriesForSeed(root: string, entries: PluginEntry[]): PluginEntry[] {
  if (entries.length <= 1) return entries
  const nodes = entries.map((entry, index) => readSeedNode(root, entry, index))
  const indexByName = new Map<string, number>()
  for (const node of nodes) {
    if (!indexByName.has(node.identity)) indexByName.set(node.identity, node.index)
    const entryName = entries[node.index].name
    if (!indexByName.has(entryName)) indexByName.set(entryName, node.index)
  }
  const ready = (node: SeedNode, done: Set<number>): boolean =>
    node.deps.every((dep) => {
      const target = indexByName.get(dep)
      return target === undefined || target === node.index || done.has(target)
    })
  const order: PluginEntry[] = []
  const done = new Set<number>()
  while (order.length < entries.length) {
    const node = nodes.find((candidate) => !done.has(candidate.index) && ready(candidate, done))
    if (node === undefined) break // 剩余项成环：原序附加
    done.add(node.index)
    order.push(entries[node.index])
  }
  for (const node of nodes) if (!done.has(node.index)) order.push(entries[node.index])
  return order
}

/**
 * 手动 / 程序化入世一个目录（`boot pack` 的纯计划面）：与 seed 共用同一打包核心
 * （`packSourceDir` + `.worldignore` + 通用排除），故同一目录同一身份产出同一 tree / commit 哈希。
 * `identity` 缺省取 `plugin.json.identity`；显式给出时作为世界身份与 `commit.meta.name`。
 * `blobsDir` 供读取旧世代的 pointer 声明（受保护引脚比对）；调用方按自己的根目录给出。
 */
export function planPack(
  world: World,
  dir: string,
  identity?: string,
  blobsDir?: string,
): IngestResult {
  try {
    const pkgRoot = resolve(dir)
    if (!existsSync(pkgRoot)) return { ok: false, reasons: ['package_not_found'] }
    if (!existsSync(join(pkgRoot, 'plugin.json'))) {
      return { ok: false, reasons: ['missing_plugin_json'] }
    }
    return planIngestAtRoot(world, pkgRoot, identity, blobsDir)
  } catch {
    return { ok: false, reasons: ['source_read_failed'] }
  }
}

/**
 * 按 `state/plugins.json` 解析某身份的**投递包源目录**（物化时直拷大资产用）。
 * 清单未登记 / 解析不到 / 清单损坏 → null（fail-closed，调用方按缺失处理）。
 */
export function resolvePluginSourceRoot(root: string, identity: string): string | null {
  let entries: PluginEntry[]
  try {
    entries = readPluginManifest(root)
  } catch {
    return null
  }
  for (const entry of entries) {
    const pkgRoot = resolvePackageRoot(entry, root)
    if (pkgRoot === null) continue
    const rawDecl = readJsonFile(join(pkgRoot, 'plugin.json'))
    if (typeof rawDecl !== 'object' || rawDecl === null || Array.isArray(rawDecl)) continue
    if ((rawDecl as { [k: string]: Json })['identity'] === identity) return pkgRoot
  }
  return null
}
