// 声明解析（只读世界）：从世界里读 `plugin.json`、解析包内路径、列出 / 解析命令。
// 只解释 `plugin.json` 形状，不校验语义；其余包内文件一律是源码 blob。

import { H } from '../../kernel/index.ts'
import { getBlob, isBlobPointer } from '../blobs.ts'
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

/** `plugin.json.build` 的一步：宿主只执行、不解释；`cmd` / `args` 是可直接交给 shell 的字面量。 */
export interface PluginBuildStep {
  cmd: string
  args: string[]
}

/**
 * `schema` 省略 / 空串时的宿主最小默认 schema def body：无世界数据的 UI 插件可零 schema
 * （`docs/plugins.md` §二），宿主机械提供一份最小体满足内核 `Identity.schema` 必需哈希。
 * 数据、非特权；宿主不解释业务，只保证身份可 `add_identity`。
 */
export const DEFAULT_SCHEMA_BODY: Json = { type: 'object' }

/** `plugin.json` 的解析结果；字段含义见插件规范，宿主只做形态检查。 */
export interface PluginDecl {
  identity: string
  /** 包内 schema 相对路径；省略 / 空串为 `null`（入世时用 `DEFAULT_SCHEMA_BODY`）。 */
  schema: string | null
  implements: string[]
  methods: Record<string, string[]>
  pins: Record<string, string>
  start: string
  /**
   * 显式构建声明（宿主只执行、不解释语言）；`null` = 字段缺失（回落宿主旧探测）。
   * 空数组是合法声明：显式表示「无需构建」，不回落探测。
   */
  build: PluginBuildStep[] | null
  /**
   * 独占资源声明：元素为资源类名（v1 只认 `port`）。非空 = 本插件的服务实例独占该资源、
   * 新旧实例不能并存（如固定端口），宿主换代时先 drain 旧服务再起新服务；空 = 无独占资源。
   * 描述的是「占用事实」，不指定宿主调度机制。
   */
  exclusive: string[]
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

/**
 * 宿主 / CLI 命令名是保留字（`host.md` §五 命令）：插件命令不得占用。
 * 与 `packages/boot/main.ts` 的 `RESERVED` 保持同口径（离线命令与 CLI 自有命令一并保留）。
 */
const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'run',
  'status',
  'seed',
  'pack',
  'verify',
  'replay',
  'compact',
  'audit',
  'assets',
  'blobs',
  'materialized',
])

function parseCommands(v: Json | undefined): PluginCommand[] | null {
  if (!Array.isArray(v)) return null
  const out: PluginCommand[] = []
  for (const item of v) {
    if (!isRecord(item)) return null
    const { name, entry, argsSchema } = item
    if (typeof name !== 'string' || name.length === 0) return null
    if (RESERVED_COMMAND_NAMES.has(name)) return null
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
 * 构建令牌白名单：`cmd` / `args` 最终由宿主按空格拼接、经 `shell:true` 交给系统 shell
 * （win32 上 `npm` 是 `.cmd` 包装脚本，`shell:false` 会 `EINVAL`）。任一令牌含空白、引号
 * 或 shell 元字符（`;` `&` `|` `$` 反引号 `*` 等）都能改写命令行，故只放行构建声明实际
 * 需要的字符集，把注入面在入世门禁掐断——比事后转义更可靠。
 */
const SAFE_BUILD_TOKEN = /^[A-Za-z0-9_./:@,+-]+$/

/**
 * 解析 `build` 声明：缺失 → `undefined`（回落旧探测）；畸形 → `null`（入世拒）。
 * 每步形如 `{cmd, args}`，`cmd` 非空、`args` 为令牌白名单内的字符串数组。
 */
function parseBuild(v: Json | undefined): PluginBuildStep[] | null | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) return null
  const out: PluginBuildStep[] = []
  for (const item of v) {
    if (!isRecord(item)) return null
    const cmd = item['cmd']
    const args = item['args']
    if (typeof cmd !== 'string' || !SAFE_BUILD_TOKEN.test(cmd)) return null
    if (!Array.isArray(args)) return null
    if (!args.every((arg) => typeof arg === 'string' && SAFE_BUILD_TOKEN.test(arg))) return null
    out.push({ cmd, args: args as string[] })
  }
  return out
}

/**
 * 独占资源类名白名单：v1 只认 `port`（绑定固定端口 / 地址的服务）。
 * 未列入的资源类宿主无法判定换人序是否安全，故显式拒绝（fail-closed），不静默当无声明处理。
 */
const EXCLUSIVE_RESOURCE_KINDS: ReadonlySet<string> = new Set(['port'])

/**
 * 解析 `exclusive` 声明：缺失 → `undefined`（无独占资源）；畸形 → `null`（入世拒）。
 * 每项是一个资源类名，只查形态与白名单，不查该资源是否真的被占用（语义不在本层）。
 */
function parseExclusive(v: Json | undefined): string[] | null | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || !EXCLUSIVE_RESOURCE_KINDS.has(item)) return null
    out.push(item)
  }
  return out
}

/**
 * 宿主侧 `plugin.json` 元 schema：14 个字段一个不少、类型正确、枚举合法
 * （`state` 只认 `recomputable`，成员 `kind` 只认 `execute` / `term` / `schema`）；
 * `schema` 可省略 / 空串（零 schema，无世界数据的 UI 插件用），显式非字符串仍拒；
 * `build` 可省略（回落宿主旧探测），显式声明则逐令牌过 shell 安全白名单。
 * 只查形状，不查语义（实现正确性、业务含义一律不在本层）。
 */
export function parsePluginDecl(value: Json): ParseDeclResult {
  if (!isRecord(value)) return { ok: false, reasons: ['bad_plugin_decl'] }
  const commands = parseCommands(value['commands'])
  const members = parseMembers(value['members'])
  const build = parseBuild(value['build'])
  const exclusive = parseExclusive(value['exclusive'])
  // `schema` 可省略或空串（零 schema 合法）；显式非字符串（含 null）仍拒——「直接省略」是唯一写法。
  const rawSchema = value['schema']
  const schema = typeof rawSchema === 'string' && rawSchema.length > 0 ? rawSchema : null
  const ok =
    typeof value['identity'] === 'string' &&
    value['identity'].length > 0 &&
    (rawSchema === undefined || typeof rawSchema === 'string') &&
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
    commands !== null &&
    build !== null &&
    exclusive !== null
  if (!ok) return { ok: false, reasons: ['bad_plugin_decl'] }
  return {
    ok: true,
    decl: {
      identity: value['identity'] as string,
      schema,
      implements: value['implements'] as string[],
      methods: value['methods'] as Record<string, string[]>,
      pins: value['pins'] as Record<string, string>,
      start: value['start'] as string,
      build: build ?? null,
      exclusive: exclusive ?? [],
      protocol: value['protocol'] as string,
      restart: value['restart'] as Json,
      health: value['health'] as Json,
      state: value['state'] as string,
      members: members as PluginMember[],
      commands: commands as PluginCommand[],
    },
  }
}

/** 包内相对路径在 tree 里的解析结果：文件或子树，附解析到的 def 键。 */
export interface TreeEntryRef {
  mode: 'file' | 'dir'
  hash: Hash
}

/** 沿 tree 解析包内相对路径，返回 `{mode, hash}`；路径不存在 / 形态非法返回 null。 */
export function resolveTreeEntry(
  world: World,
  treeHash: Hash,
  relPath: string,
): TreeEntryRef | null {
  const parts = relPath.split('/').filter((p) => p.length > 0 && p !== '.')
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
      if (mode !== 'file' && mode !== 'dir') return null
      return { mode, hash }
    }
    if (mode !== 'dir') return null
    currentTree = hash
  }
  return null
}

/**
 * 沿 tree 解析包内相对路径，返回文件文本；路径不存在或不是文件返回 null。
 * 文本 blob 有两种形态：inline（旧世界，body 为字符串）与 pointer（body 为内容引用，
 * 经 `blobsDir` 读 CAS 字节）。pointer 字节 UTF-8 往返不一致（二进制资产）→ 不参与 JSON 解析。
 * `blobsDir` 缺失而遇 pointer → null（fail-closed，不猜内容）。
 */
export function resolveTreeBlob(
  world: World,
  treeHash: Hash,
  relPath: string,
  blobsDir?: string,
): string | null {
  const entry = resolveTreeEntry(world, treeHash, relPath)
  if (entry === null || entry.mode !== 'file') return null
  const blob = world.defs[entry.hash]
  const body = blob?.body
  if (isBlobPointer(body)) {
    if (blobsDir === undefined) return null
    const read = getBlob(blobsDir, body)
    if (!read.ok) return null
    const text = read.bytes.toString('utf8')
    return Buffer.from(text, 'utf8').equals(read.bytes) ? text : null
  }
  if (typeof body !== 'string') return null
  // base64 blob 是字节资产，不是文本；不参与 JSON 解析
  if ((blob as { enc?: Json }).enc === 'base64') return null
  return body
}

/** 读指定世代的 `plugin.json`；缺任一步返回 null（供换代比对按旧世代读声明）。 */
export function readPluginDeclOfGen(world: World, gen: Gen, blobsDir?: string): DeclRead | null {
  const commit = world.defs[gen.payload]
  const tree = (commit?.body as { tree?: Json } | undefined)?.tree
  if (typeof tree !== 'string') return null
  const text = resolveTreeBlob(world, tree, 'plugin.json', blobsDir)
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

/**
 * 世代二分（G7 A1）：payload def 的 body.tree 是字符串 ⇒ 代码世代（指向 commit def）；
 * 其余（payload 指向数据 def）为数据世代。只做机械形态判断，不解析 plugin.json。
 */
export function isCodeGen(world: World, gen: Gen): boolean {
  const body = world.defs[gen.payload]?.body
  return typeof (body as { tree?: Json } | undefined)?.tree === 'string'
}

/** 最近的代码世代（`gens` 从后往前第一个 commit def）；无则 null。 */
export function latestCodeGen(world: World, identityId: string): Gen | null {
  const identity = world.ids[identityId]
  if (identity === undefined) return null
  for (let i = identity.gens.length - 1; i >= 0; i--) {
    if (isCodeGen(world, identity.gens[i])) return identity.gens[i]
  }
  return null
}

/** 最近的数据世代（payload def 存在且非 commit def）；无则 null（投影 `body` 取它）。 */
export function latestDataGen(world: World, identityId: string): Gen | null {
  const identity = world.ids[identityId]
  if (identity === undefined) return null
  for (let i = identity.gens.length - 1; i >= 0; i--) {
    const gen = identity.gens[i]
    if (world.defs[gen.payload] === undefined) continue
    if (!isCodeGen(world, gen)) return gen
  }
  return null
}

/**
 * 装配取用世代（G7 A1）：active 是代码世代 ⇒ 取 active（尊重 `set_active` 回滚）；
 * active 是数据世代 ⇒ 取最近代码世代（装配按最近 commit 解析）；
 * 无代码世代（合成世界 / 无 tree 世代）回落 active；`active=null`（retired）→ null。
 */
export function assemblyGen(world: World, identityId: string): Gen | null {
  const identity = world.ids[identityId]
  if (identity === undefined || identity.active === null) return null
  const activeGen = identity.gens.find((gen) => gen.payload === identity.active) ?? null
  if (activeGen !== null && isCodeGen(world, activeGen)) return activeGen
  const code = latestCodeGen(world, identityId)
  if (code !== null) return code
  return activeGen
}

/**
 * 读身份装配世代的 `plugin.json`（G7 A1）：数据世代不参与声明解析；
 * 无代码世代 / 装配世代的 `plugin.json` 不可解析 → null（fail-closed，不回落更旧世代）。
 */
export function readPluginDecl(
  world: World,
  identityId: string,
  blobsDir?: string,
): DeclRead | null {
  const identity = world.ids[identityId]
  if (!identity || identity.active === null) return null
  const gen = assemblyGen(world, identityId)
  if (gen === null) return null
  return readPluginDeclOfGen(world, gen, blobsDir)
}

/** term def 的规范构造：body = AST、sig = 世代签名；读侧与入世侧共用同一构造。 */
export function termDefOf(ast: Json, sig: Hash): { body: Json; sig: Hash } {
  return { body: ast, sig }
}

/** 沿 tree 读一个 JSON 文件；缺失或非 JSON 返回 undefined。 */
export function resolveTreeJson(
  world: World,
  treeHash: Hash,
  relPath: string,
  blobsDir?: string,
): Json | undefined {
  const text = resolveTreeBlob(world, treeHash, relPath, blobsDir)
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
function resolveTermHash(
  world: World,
  treeHash: Hash,
  relPath: string,
  sig: Hash,
  blobsDir?: string,
): Hash | null {
  const memo = new Map<string, Hash>()
  const visiting = new Set<string>()
  const resolve = (current: string): Hash | null => {
    const cached = memo.get(current)
    if (cached !== undefined) return cached
    if (visiting.has(current)) return null
    const ast = resolveTreeJson(world, treeHash, current, blobsDir)
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
export function listCommands(world: World, blobsDir?: string): CommandDecl[] {
  const out: CommandDecl[] = []
  for (const identityId of Object.keys(world.ids).sort()) {
    const read = readPluginDecl(world, identityId, blobsDir)
    if (!read) continue
    for (const cmd of read.decl.commands) {
      const entry = resolveTermHash(world, read.tree, cmd.entry, read.gen.sig, blobsDir)
      if (entry === null) continue
      const argsSchema =
        cmd.argsSchema === undefined
          ? null
          : (() => {
              const schema = resolveTreeJson(world, read.tree, cmd.argsSchema as string, blobsDir)
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
export function resolveCommand(world: World, name: string, blobsDir?: string): CommandDecl | null {
  for (const cmd of listCommands(world, blobsDir)) {
    if (cmd.name === name) return cmd
  }
  return null
}
