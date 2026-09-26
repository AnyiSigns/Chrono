// 入世计划：把插件包源码树变成一条原子 batch 的子操作序列（纯计划，不落账）。
// 计划由调用方（离线 seed）交给世界写口提交；assembly 只读世界、不写链。
// 排除与 term `$ref` 替换都在本层做：宿主只做机械解析，不认识语义。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { H } from '../../kernel/index.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { appendLifecycle } from '../lifecycle.ts'
import { hostPaths } from '../paths.ts'
import { readProtectedPins } from '../protected-pins.ts'
import { isRecord } from '../common/json.ts'
import { MinHeap } from '../common/min-heap.ts'
import {
  isSafeIdentityName,
  isSafeRelativePath,
  normalizeRefPath,
  pathSegments,
} from '../common/paths-safe.ts'
import { validateArgsSchema } from './args-schema.ts'
import {
  DEFAULT_SCHEMA_BODY,
  isCodeGen,
  latestCodeGen,
  parsePluginDecl,
  readPluginDecl,
  readPluginDeclOfGen,
  termDefOf,
} from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { validateEffDecls } from './eff-decls.ts'
import type { EffDeclContext } from './eff-decls.ts'
import { isIgnored, packSourceDir, readWorldignore } from './source.ts'
import type { PackedBlob } from './source.ts'
import { collectRefs, replaceTermRefs, termTopoOrder } from './term-refs.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

/**
 * 插件投递项：有 path 按路径解析，无 path 走 Node 解析（`node_modules`）。
 * `exclude` 为真时从并集里移除同名项（目录发现的显式排除）。
 */
export interface PluginEntry {
  name: string
  path?: string
  exclude?: boolean
}

/** 读 `state/plugins.json` 清单本身；缺文件即空；形态非法抛 `bad_plugins_manifest`。 */
function readManifestFile(root: string): PluginEntry[] {
  const file = hostPaths(root).pluginsFile
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('bad_plugins_manifest')
  return parsed.map((item) => {
    if (!isRecord(item)) throw new Error('bad_plugins_manifest')
    const record = item as { name?: unknown; path?: unknown; exclude?: unknown }
    if (typeof record.name !== 'string' || record.name.length === 0) {
      throw new Error('bad_plugins_manifest')
    }
    const entry: PluginEntry = { name: record.name }
    if (record.path !== undefined) entry.path = String(record.path)
    if (record.exclude !== undefined) {
      if (typeof record.exclude !== 'boolean') throw new Error('bad_plugins_manifest')
      entry.exclude = record.exclude
    }
    return entry
  })
}

/** 已记过「发现跳过」运维日志的 `root\0目录`：同一目录只记一次，避免逐次解析重记。 */
const discoveryLogged = new Set<string>()

function logDiscoverySkip(root: string, dir: string, reason: string): void {
  const key = `${resolve(root)}\u0000${dir}`
  if (discoveryLogged.has(key)) return
  discoveryLogged.add(key)
  appendLifecycle(hostPaths(root).lifecycleFile, {
    at: Date.now(),
    kind: 'host',
    event: 'plugin_discovery_skipped',
    reason: `${dir}:${reason}`,
  })
}

/**
 * 目录发现：扫 `plugins` 下各子目录的 `plugin.json` 得到投递项（path = `plugins/<目录名>`）。
 * 目录名不安全 → 跳过并记运维日志；`plugin.json` 读不出 / 解析失败 → 跳过并记日志，不 fail-stop
 * （一个坏目录不得挡住整个启动）。不含 `plugin.json` 的目录不是插件，静默跳过。
 */
function discoverPluginEntries(root: string): PluginEntry[] {
  const dir = join(root, 'plugins')
  if (!existsSync(dir)) return []
  const out: PluginEntry[] = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const name = dirent.name
    if (!isSafeIdentityName(name)) {
      logDiscoverySkip(root, name, 'unsafe_name')
      continue
    }
    const pkgRoot = join(dir, name)
    if (!existsSync(join(pkgRoot, 'plugin.json'))) continue
    if (readJsonFile(join(pkgRoot, 'plugin.json')) === undefined) {
      logDiscoverySkip(root, name, 'unreadable_plugin_json')
      continue
    }
    out.push({ name, path: `plugins/${name}` })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

/**
 * 读有效插件清单：目录发现 ∪ 清单，同名以清单项优先（清单可覆盖路径），排除项从并集移除。
 * 清单不存在 / 为空 → 纯目录发现；真实身份仍取包内 `plugin.json.identity`，清单 `name` 只是解析标签。
 */
export function readPluginManifest(root: string): PluginEntry[] {
  const manifest = readManifestFile(root)
  const byName = new Map<string, PluginEntry>()
  for (const entry of discoverPluginEntries(root)) byName.set(entry.name, entry)
  for (const entry of manifest) {
    if (entry.exclude === true) continue
    byName.set(entry.name, entry)
  }
  for (const entry of manifest) {
    if (entry.exclude === true) byName.delete(entry.name)
  }
  return [...byName.values()]
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
 * 跨代比对 `pins`：最近代码世代引用了某受保护身份、新声明不再引用 → 删了保护边。
 * 按被依赖身份名比对（`decl.pins` 的值即身份名），不涉及解析后的哈希。
 * 不依赖 `active`：retired 身份重入世同样按最近代码世代比对，否则「退役→重入世」可绕过保护。
 * 身份不存在 / 无代码世代 → 无从比对，放行；有代码世代但声明读不出 → fail-closed 拒。
 * 受保护名单来自运营配置（`chrono.config.json` 的 `protected_pins`），不在源码里写死身份名。
 */
function removedProtectedPin(
  world: World,
  identity: string,
  decl: PluginDecl,
  blobsDir: string | undefined,
  protectedPins: ReadonlySet<string>,
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
    if (protectedPins.has(depId) && !nextPins.has(depId)) return true
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
  if (isRecord(pkg)) {
    const version = pkg['version']
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

/** 找第一个逃逸包根的声明路径（schema / 命令入口 / 参数 schema / members）；无则 null。 */
function unsafeDeclaredPath(decl: PluginDecl): string | null {
  const candidates: string[] = decl.schema === null ? [] : [decl.schema]
  for (const command of decl.commands) {
    candidates.push(command.entry)
    if (command.argsSchema !== undefined) candidates.push(command.argsSchema)
  }
  for (const member of decl.members) candidates.push(member.path)
  return candidates.find((candidate) => !isSafeRelativePath(candidate)) ?? null
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
 * 同时校验每个 term 的 `eff` 声明（`undeclared_port` / `undeclared_method`），口径见 `eff-decls.ts`。
 */
function planTerms(
  pkgRoot: string,
  decl: PluginDecl,
  commitHash: Hash,
  ops: Json[],
  world: World,
  blobsDir: string | undefined,
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

  const effCtx: EffDeclContext = {
    implements: new Set(decl.implements),
    pins: new Set(Object.keys(decl.pins)),
    methods: decl.methods,
    calleeMethodsOf: (port) => {
      const depId = decl.pins[port]
      // 保留能力类 `host` 不在世界里，按「看不到被调声明」跳过方法名校验。
      if (depId === undefined || depId === HOST_CAPABILITY) return null
      const read = readPluginDecl(world, depId, blobsDir)
      return read === null ? null : read.decl.methods
    },
  }
  for (const path of all) {
    const issues = validateEffDecls(asts.get(path) as Json, effCtx)
    if (issues.length > 0) return { ok: false, reasons: issues }
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
  protectedPins: ReadonlySet<string>,
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

  if (removedProtectedPin(world, identity, decl, blobsDir, protectedPins)) {
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

  const terms = planTerms(pkgRoot, decl, commitHash, ops, world, blobsDir)
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
    const pins = readProtectedPins(root)
    if (pins.reason !== undefined) return { ok: false, reasons: [pins.reason] }
    const pkgRoot = resolvePackageRoot(entry, root)
    if (pkgRoot === null) return { ok: false, reasons: ['package_not_found'] }
    return planIngestAtRoot(world, pkgRoot, undefined, hostPaths(root).blobsDir, pins.identities)
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
  // 入度 = 清单内、非自身的不同依赖数；dependents 记录谁依赖我，供完成时递减。
  const remaining = new Map<number, number>()
  const dependents = new Map<number, Set<number>>()
  for (const node of nodes) {
    const targets = new Set<number>()
    for (const dep of node.deps) {
      const target = indexByName.get(dep)
      if (target === undefined || target === node.index) continue
      targets.add(target)
    }
    remaining.set(node.index, targets.size)
    for (const target of targets) {
      const list = dependents.get(target)
      if (list === undefined) dependents.set(target, new Set([node.index]))
      else list.add(node.index)
    }
  }
  // 就绪前沿按下标取最小：与「每轮线性找最小 ready 下标」等价，但整体 O(n log n)。
  const ready = new MinHeap<number>((a, b) => a - b)
  for (const node of nodes) if (remaining.get(node.index) === 0) ready.push(node.index)
  const order: PluginEntry[] = []
  const done = new Set<number>()
  for (let index = ready.pop(); index !== undefined; index = ready.pop()) {
    done.add(index)
    order.push(entries[index])
    for (const dependent of dependents.get(index) ?? []) {
      const left = (remaining.get(dependent) as number) - 1
      remaining.set(dependent, left)
      if (left === 0) ready.push(dependent)
    }
  }
  for (const node of nodes) if (!done.has(node.index)) order.push(entries[node.index])
  return order
}

/**
 * 手动 / 程序化入世一个目录（`boot pack` 的纯计划面）：与 seed 共用同一打包核心
 * （`packSourceDir` + `.worldignore` + 通用排除），故同一目录同一身份产出同一 tree / commit 哈希。
 * `identity` 缺省取 `plugin.json.identity`；显式给出时作为世界身份与 `commit.meta.name`。
 * `blobsDir` 供读取旧世代的 pointer 声明（受保护引脚比对）；调用方按自己的根目录给出。
 * `configRoot` 给定时从该根的 `chrono.config.json` 读受保护 pin 名单（`validate_package` 的候选目录
 * 不是仓库根，故不能从 `dir` 读）；缺省不设保护（空集）。
 */
export function planPack(
  world: World,
  dir: string,
  identity?: string,
  blobsDir?: string,
  configRoot?: string,
): IngestResult {
  try {
    const pkgRoot = resolve(dir)
    if (!existsSync(pkgRoot)) return { ok: false, reasons: ['package_not_found'] }
    if (!existsSync(join(pkgRoot, 'plugin.json'))) {
      return { ok: false, reasons: ['missing_plugin_json'] }
    }
    let protectedPins: ReadonlySet<string> = new Set()
    if (configRoot !== undefined) {
      const pins = readProtectedPins(configRoot)
      if (pins.reason !== undefined) return { ok: false, reasons: [pins.reason] }
      protectedPins = pins.identities
    }
    return planIngestAtRoot(world, pkgRoot, identity, blobsDir, protectedPins)
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
    if (!isRecord(rawDecl)) continue
    if (rawDecl['identity'] === identity) return pkgRoot
  }
  return null
}
