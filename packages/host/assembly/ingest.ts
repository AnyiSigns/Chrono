// 入世计划：把插件包源码树变成一条原子 batch 的子操作序列（纯计划，不落账）。
// 计划由调用方（离线 seed）交给唯一写口提交；assembly 只读世界、不写链。
// 排除与 term `$ref` 替换都在本层做：宿主只做机械解析，不认识语义。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { H } from '../../kernel/index.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { isSafeIdentityName } from './identity-name.ts'
import { validateArgsSchema } from './args-schema.ts'
import {
  isCodeGen,
  latestCodeGen,
  parsePluginDecl,
  readPluginDeclOfGen,
  termDefOf,
} from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { isIgnored, packSourceDir, pathSegments, readWorldignore } from './source.ts'
import { collectRefs, normalizeRefPath, replaceTermRefs, termTopoOrder } from './term-refs.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

/** `state/plugins.json` 的一项：有 path 按路径解析，无 path 走 Node 解析。 */
export interface PluginEntry {
  name: string
  path?: string
}

export interface IngestPlan {
  identity: string
  ops: Json[]
  isNewIdentity: boolean
  commitHash: Hash
  schemaHash: Hash
  /** 同源码已 active：不产生任何子操作。 */
  unchanged: boolean
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
 * 受保护身份（住宿主侧、不进世界，故连代码换代也改不动）：新世代删除对它们的 `pins` 引用即整批拒。
 * 理由：可见性过滤是黑名单，攻击面在依赖关系——agent 可写一个不 pin `sandbox` 的 `tool-fs` 让强制失效。
 * 这是纯机械的「旧世代有、新世代没了」比对，宿主不认识业务。
 */
const PROTECTED_PIN_IDENTITIES: ReadonlySet<string> = new Set([
  'sandbox',
  'guard',
  'secrets',
  'approval',
])

/**
 * 跨代比对 `pins`：最近代码世代引用了某受保护身份、新声明不再引用 → 删了保护边。
 * 按被依赖身份名比对（`decl.pins` 的值即身份名），不涉及解析后的哈希。
 * 不依赖 `active`：retired 身份重入世同样按最近代码世代比对，否则「退役→重入世」可绕过保护。
 * 身份不存在 / 无代码世代 → 无从比对，放行；有代码世代但声明读不出 → fail-closed 拒。
 */
function removedProtectedPin(world: World, identity: string, decl: PluginDecl): boolean {
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
  const previous = readPluginDeclOfGen(world, codeGen)
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
  const candidates: string[] = [decl.schema]
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
  const candidates = new Set<string>(['plugin.json', 'package.json', 'README.md', decl.schema])
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
): IngestPlan {
  const isNewIdentity = !Object.hasOwn(world.ids, identity)
  if (isNewIdentity) {
    ops.push({ op: 'add_identity', args: { id: identity, schema: { $n: schemaIndex } } })
  }
  ops.push({
    op: 'add_gen',
    args: { id: identity, payload: { $n: commitIndex }, pins, sig: { $n: commitIndex } },
  })
  return { identity, ops, isNewIdentity, commitHash, schemaHash, unchanged: false }
}

/**
 * 已解析包根的入世核心：`identity` 缺省取 `plugin.json.identity`（seed 路径）；
 * `pack` 显式给出身份名时必须与包内声明**一致**（命名即契约，单源），不一致即拒。
 */
function planIngestAtRoot(world: World, pkgRoot: string, identityOverride?: string): IngestResult {
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

  if (removedProtectedPin(world, identity, decl)) {
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

  const schemaJson = readJsonFile(join(pkgRoot, decl.schema))
  if (schemaJson === undefined) return { ok: false, reasons: ['missing_schema'] }
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
    ),
  }
}

/** 解析一个插件包并构造入世 batch 计划；不改世界、不落账。 */
export function planIngest(world: World, root: string, entry: PluginEntry): IngestResult {
  const pkgRoot = resolvePackageRoot(entry, root)
  if (pkgRoot === null) return { ok: false, reasons: ['package_not_found'] }
  return planIngestAtRoot(world, pkgRoot)
}

/**
 * 手动 / 程序化入世一个目录（`boot pack` 的纯计划面）：与 seed 共用同一打包核心
 * （`packSourceDir` + `.worldignore` + 通用排除），故同一目录同一身份产出同一 tree / commit 哈希。
 * `identity` 缺省取 `plugin.json.identity`；显式给出时作为世界身份与 `commit.meta.name`。
 */
export function planPack(world: World, dir: string, identity?: string): IngestResult {
  const pkgRoot = resolve(dir)
  if (!existsSync(pkgRoot)) return { ok: false, reasons: ['package_not_found'] }
  if (!existsSync(join(pkgRoot, 'plugin.json'))) {
    return { ok: false, reasons: ['missing_plugin_json'] }
  }
  return planIngestAtRoot(world, pkgRoot, identity)
}
