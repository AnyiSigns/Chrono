// 声明解析（只读世界）：从世界里读 `plugin.json`、解析包内路径、列出 / 解析命令。
// 只解释 `plugin.json` 形状，不校验语义；其余包内文件一律是源码 blob。

import { H } from '../../kernel/index.ts'
import { replaceTermRefs } from './term-refs.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

export interface PluginCommand {
  name: string
  entry: string
  argsSchema?: string
}

export interface PluginMember {
  kind: string
  path: string
}

/** `plugin.json` 的解析结果；字段含义见插件规范，宿主只做形态检查。 */
export interface PluginDecl {
  identity: string
  schema: string
  implements: string[]
  methods: Record<string, string[]>
  pins: Record<string, string>
  start: string
  protocol: string
  restart: Json
  health: Json
  state: string
  members: PluginMember[]
  commands: PluginCommand[]
}

/** 命令声明解析后的形态：入口与参数 schema 已解析成 def 哈希。 */
export interface CommandDecl {
  identity: string
  name: string
  entry: Hash
  argsSchema: Hash | null
}

export interface DeclRead {
  decl: PluginDecl
  gen: Gen
  tree: Hash
}

export type ParseDeclResult = { ok: true; decl: PluginDecl } | { ok: false; reasons: string[] }

function isRecord(v: Json | undefined): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: Json | undefined): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isStringMap(v: Json | undefined): v is Record<string, string> {
  if (!isRecord(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

function parseCommands(v: Json | undefined): PluginCommand[] | null {
  if (!Array.isArray(v)) return null
  const out: PluginCommand[] = []
  for (const item of v) {
    if (!isRecord(item)) return null
    const { name, entry, argsSchema } = item
    if (typeof name !== 'string' || name.length === 0) return null
    if (typeof entry !== 'string' || entry.length === 0) return null
    if (argsSchema !== undefined && typeof argsSchema !== 'string') return null
    out.push(argsSchema === undefined ? { name, entry } : { name, entry, argsSchema })
  }
  return out
}

/** 成员种类：驱动数据热生效 / 代码起新服务，只认这三种。 */
const MEMBER_KINDS = new Set(['execute', 'term', 'schema'])

function parseMembers(v: Json | undefined): PluginMember[] | null {
  if (!Array.isArray(v)) return null
  const out: PluginMember[] = []
  for (const item of v) {
    if (!isRecord(item)) return null
    const kind = item['kind']
    if (typeof kind !== 'string' || !MEMBER_KINDS.has(kind)) return null
    if (typeof item['path'] !== 'string') return null
    out.push({ kind, path: item['path'] })
  }
  return out
}

/**
 * 宿主侧 `plugin.json` 元 schema：12 个字段一个不少、类型正确、枚举合法
 * （`state` 只认 `recomputable`，成员 `kind` 只认 `execute` / `term` / `schema`）。
 * 只查形状，不查语义（实现正确性、业务含义一律不在本层）。
 */
export function parsePluginDecl(value: Json): ParseDeclResult {
  if (!isRecord(value)) return { ok: false, reasons: ['bad_plugin_decl'] }
  const commands = parseCommands(value['commands'])
  const members = parseMembers(value['members'])
  const ok =
    typeof value['identity'] === 'string' &&
    value['identity'].length > 0 &&
    typeof value['schema'] === 'string' &&
    value['schema'].length > 0 &&
    isStringArray(value['implements']) &&
    isRecord(value['methods']) &&
    Object.values(value['methods']).every(isStringArray) &&
    isStringMap(value['pins']) &&
    typeof value['start'] === 'string' &&
    typeof value['protocol'] === 'string' &&
    isRecord(value['restart']) &&
    isRecord(value['health']) &&
    value['state'] === 'recomputable' &&
    members !== null &&
    commands !== null
  if (!ok) return { ok: false, reasons: ['bad_plugin_decl'] }
  return {
    ok: true,
    decl: {
      identity: value['identity'] as string,
      schema: value['schema'] as string,
      implements: value['implements'] as string[],
      methods: value['methods'] as Record<string, string[]>,
      pins: value['pins'] as Record<string, string>,
      start: value['start'] as string,
      protocol: value['protocol'] as string,
      restart: value['restart'] as Json,
      health: value['health'] as Json,
      state: value['state'] as string,
      members: members as PluginMember[],
      commands: commands as PluginCommand[],
    },
  }
}

/** 沿 tree 解析包内相对路径，返回文件文本；路径不存在或不是文件返回 null。 */
export function resolveTreeBlob(world: World, treeHash: Hash, relPath: string): string | null {
  const parts = relPath.split('/').filter((p) => p.length > 0)
  if (parts.length === 0) return null
  let currentTree = treeHash
  for (let i = 0; i < parts.length; i++) {
    const treeDef = world.defs[currentTree]
    const entries = (treeDef?.body as { entries?: Json } | undefined)?.entries
    if (!Array.isArray(entries)) return null
    const found = entries.find((e) => isRecord(e) && e['name'] === parts[i])
    if (!isRecord(found)) return null
    const hash = found['hash']
    const mode = found['mode']
    if (typeof hash !== 'string') return null
    if (i === parts.length - 1) {
      if (mode !== 'file') return null
      const blob = world.defs[hash]
      if (typeof blob?.body !== 'string') return null
      // base64 blob 是字节资产，不是文本；不参与 JSON 解析
      if ((blob as { enc?: Json }).enc === 'base64') return null
      return blob.body
    }
    if (mode !== 'dir') return null
    currentTree = hash
  }
  return null
}

/** 读身份当前 active 世代的 `plugin.json`；缺任一步返回 null。 */
export function readPluginDecl(world: World, identityId: string): DeclRead | null {
  const identity = world.ids[identityId]
  if (!identity || identity.active === null) return null
  const gen = identity.gens.find((g) => g.payload === identity.active)
  if (!gen) return null
  const commit = world.defs[gen.payload]
  const tree = (commit?.body as { tree?: Json } | undefined)?.tree
  if (typeof tree !== 'string') return null
  const text = resolveTreeBlob(world, tree, 'plugin.json')
  if (text === null) return null
  let parsed: Json
  try {
    parsed = JSON.parse(text) as Json
  } catch {
    return null
  }
  const result = parsePluginDecl(parsed)
  return result.ok ? { decl: result.decl, gen, tree } : null
}

/** term def 的规范构造：body = AST、sig = 世代签名；读侧与入世侧共用同一构造。 */
export function termDefOf(ast: Json, sig: Hash): { body: Json; sig: Hash } {
  return { body: ast, sig }
}

/** 沿 tree 读一个 JSON 文件；缺失或非 JSON 返回 undefined。 */
export function resolveTreeJson(world: World, treeHash: Hash, relPath: string): Json | undefined {
  const text = resolveTreeBlob(world, treeHash, relPath)
  if (text === null) return undefined
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}

/**
 * 从世界 tree 解析一个 term 源（`terms/` 下或命令入口）的实际 def 哈希：
 * 递归把 `$ref` 占位符替换成 callee def 哈希，`sig` 为本世代签名。
 * 缺失 / 坏引用 / 成环返回 null（入世侧已把成环整包拒，此处只作防御）。
 */
function resolveTermHash(world: World, treeHash: Hash, relPath: string, sig: Hash): Hash | null {
  const memo = new Map<string, Hash>()
  const visiting = new Set<string>()
  const resolve = (current: string): Hash | null => {
    const cached = memo.get(current)
    if (cached !== undefined) return cached
    if (visiting.has(current)) return null
    const ast = resolveTreeJson(world, treeHash, current)
    if (ast === undefined) return null
    visiting.add(current)
    const replaced = replaceTermRefs(ast, (ref) => resolve(ref))
    visiting.delete(current)
    if (!replaced.ok) return null
    const hash = H(termDefOf(replaced.value, sig))
    memo.set(current, hash)
    return hash
  }
  return resolve(relPath)
}

/** 列出世界里所有身份的具名命令；无法解析声明的身份跳过。 */
export function listCommands(world: World): CommandDecl[] {
  const out: CommandDecl[] = []
  for (const identityId of Object.keys(world.ids).sort()) {
    const read = readPluginDecl(world, identityId)
    if (!read) continue
    for (const cmd of read.decl.commands) {
      const entry = resolveTermHash(world, read.tree, cmd.entry, read.gen.sig)
      if (entry === null) continue
      const argsSchema =
        cmd.argsSchema === undefined
          ? null
          : (() => {
              const schema = resolveTreeJson(world, read.tree, cmd.argsSchema as string)
              return schema === undefined ? null : H({ body: schema } as unknown as Json)
            })()
      out.push({
        identity: identityId,
        name: cmd.name,
        entry,
        argsSchema,
      })
    }
  }
  return out
}

/** 按命令名解析到入口 def；重名取身份 id 字典序最小者。 */
export function resolveCommand(world: World, name: string): CommandDecl | null {
  for (const cmd of listCommands(world)) {
    if (cmd.name === name) return cmd
  }
  return null
}
