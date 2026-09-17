// 入世计划：把插件包源码树变成一条原子 batch 的子操作序列（纯计划，不落账）。
// 计划由调用方（离线 seed）交给唯一写口提交；assembly 只读世界、不写链。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { H } from '../../kernel/index.ts'
import { parsePluginDecl, termDefOf } from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { packSourceDir } from './source.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

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

/** 解析插件包根目录：path 优先，其次 Node 解析；都找不到返回 null。 */
export function resolvePackageRoot(entry: PluginEntry, root: string): string | null {
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

function planIdentity(
  world: World,
  decl: PluginDecl,
  pins: Record<string, Hash>,
  ops: Json[],
  commitIndex: number,
  schemaIndex: number,
  commitHash: Hash,
  schemaHash: Hash,
): IngestPlan {
  const isNewIdentity = world.ids[decl.identity] === undefined
  if (isNewIdentity) {
    ops.push({ op: 'add_identity', args: { id: decl.identity, schema: { $n: schemaIndex } } })
  }
  ops.push({
    op: 'add_gen',
    args: { id: decl.identity, payload: { $n: commitIndex }, pins, sig: { $n: commitIndex } },
  })
  return { identity: decl.identity, ops, isNewIdentity, commitHash, schemaHash, unchanged: false }
}

/** 解析一个插件包并构造入世 batch 计划；不改世界、不落账。 */
export function planIngest(world: World, root: string, entry: PluginEntry): IngestResult {
  const pkgRoot = resolvePackageRoot(entry, root)
  if (pkgRoot === null) return { ok: false, reasons: ['package_not_found'] }
  const rawDecl = readJsonFile(join(pkgRoot, 'plugin.json'))
  if (rawDecl === undefined) return { ok: false, reasons: ['missing_plugin_json'] }
  const parsed = parsePluginDecl(rawDecl)
  if (!parsed.ok) return parsed
  const decl = parsed.decl

  const pins: Record<string, Hash> = {}
  for (const [name, depId] of Object.entries(decl.pins)) {
    const dep = world.ids[depId]
    if (!dep || dep.active === null) return { ok: false, reasons: [`unresolved_pin:${name}`] }
    pins[name] = dep.active
  }

  const packed = packSourceDir(pkgRoot)
  const ops: Json[] = [...packed.ops]
  const meta = { name: decl.identity, version: readPackageVersion(pkgRoot) }
  const commitHash = H({ body: { tree: packed.rootTreeHash, meta } } as unknown as Json)
  const commitIndex = ops.length
  ops.push({ op: 'put', args: { body: { tree: { $n: packed.rootTreeIndex }, meta } } })

  const schemaJson = readJsonFile(join(pkgRoot, decl.schema))
  if (schemaJson === undefined) return { ok: false, reasons: ['missing_schema'] }
  const schemaHash = H({ body: schemaJson } as unknown as Json)
  const schemaIndex = ops.length
  ops.push({ op: 'put', args: { body: schemaJson } })

  const termPaths = new Set<string>()
  const collected: string[] = []
  collectJsonFiles(join(pkgRoot, 'terms'), 'terms', collected)
  for (const path of collected) termPaths.add(path)
  for (const cmd of decl.commands) termPaths.add(cmd.entry)
  for (const path of termPaths) {
    const ast = readJsonFile(join(pkgRoot, path))
    if (ast === undefined) return { ok: false, reasons: [`missing_entry:${path}`] }
    ops.push({ op: 'put', args: termDefOf(ast, commitHash) })
  }
  for (const cmd of decl.commands) {
    if (cmd.argsSchema === undefined) continue
    const schema = readJsonFile(join(pkgRoot, cmd.argsSchema))
    if (schema === undefined)
      return { ok: false, reasons: [`missing_args_schema:${cmd.argsSchema}`] }
    ops.push({ op: 'put', args: { body: schema } })
  }

  const existing = world.ids[decl.identity]
  if (existing && existing.active === commitHash) {
    return {
      ok: true,
      plan: {
        identity: decl.identity,
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
    plan: planIdentity(world, decl, pins, ops, commitIndex, schemaIndex, commitHash, schemaHash),
  }
}
