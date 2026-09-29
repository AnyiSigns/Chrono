// 声明解析（只读世界）：从世界里读 `plugin.json`、解析包内路径、列出 / 解析命令。
// 只解释 `plugin.json` 形状，不校验语义；其余包内文件一律是源码 blob。

import { H } from '../../kernel/index.ts'
import { getBlob, isBlobPointer } from '../blobs.ts'
import { FRAMEWORK_COMMAND_NAME_SET } from '../common/framework-commands.ts'
import { PROTOTYPE_KEYS, isRecord, isStringArray, isStringMap } from '../common/json.ts'
import { isSafeRelativePath } from '../common/paths-safe.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { replaceTermRefs } from './term-refs.ts'
import type { ServiceTransport } from '../service-link.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

export interface PluginCommand {
  name: string
  entry: string
  argsSchema?: string
  /** 只读命令：执行不广播 run 事件、不写审计 / 账本；缺省 false。 */
  readonly: boolean
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

/** 消费方引用能力类的方式：`one` 单提供方绑定，`many` 按世界解析成提供方集合。 */
export type NeedMode = 'one' | 'many'

/** `needs` 的一个条目：消费方对某能力类的引用（`methods` 仅在无拥有方契约时必填）。 */
export interface NeedDecl {
  mode: NeedMode
  /** 契约方法名；缺省表示按拥有方 `slots[cap]` 契约（世界级，decl 层看不到）。 */
  methods?: string[]
}

/** `slots` 的一个条目：拥有方对某能力类声明的方法契约。 */
export interface SlotDecl {
  methods: string[]
}

/** `plugin.json` 的解析结果；字段含义见插件规范，宿主只做形态检查。 */
export interface PluginDecl {
  identity: string
  /** 包内 schema 相对路径；省略 / 空串为 `null`（入世时用 `DEFAULT_SCHEMA_BODY`）。 */
  schema: string | null
  implements: string[]
  methods: Record<string, string[]>
  pins: Record<string, string>
  /** 消费方引用的能力类（`cap → 引用方式`）；省略为空表。 */
  needs: Record<string, NeedDecl>
  /** 拥有方声明契约的能力类（`cap → 方法契约`）；省略为空表。 */
  slots: Record<string, SlotDecl>
  start: string
  /**
   * 服务传输形态：`stdio`（缺省）/ `inproc` / `worker`。由 `plugin.json.transport` 声明；
   * `inproc` / `worker` 下 `start` 是**同语言入口模块路径**（相对物化目录），不是 shell 命令。
   */
  transport: ServiceTransport
  /**
   * 显式构建声明（宿主只执行、不解释语言）；**字段必需**——缺失即入世拒 `bad_plugin_decl`。
   * 空数组是合法声明：显式表示「无需构建」。
   */
  build: PluginBuildStep[]
  /**
   * 独占资源声明：元素为资源类名（开放命名，如 `port` / `data`）。非空 = 本插件的服务实例独占该资源、
   * 新旧实例不能并存（如固定端口、单写句柄的持久存储），宿主换代时先 drain 旧服务再起新服务；
   * 空 = 无独占资源。描述的是「占用事实」，不指定宿主调度机制。
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
  /** 只读命令：执行不广播 run 事件、不写审计 / 账本；缺省 false。 */
  readonly: boolean
}

export interface DeclRead {
  decl: PluginDecl
  gen: Gen
  tree: Hash
}

export type ParseDeclResult = { ok: true; decl: PluginDecl } | { ok: false; reasons: string[] }

type ParseCommandsResult = { ok: true; commands: PluginCommand[] } | { ok: false; reason: string }

/**
 * 解析命令声明：保留命令名给专用拒绝码 `reserved_command_name`（作者能看出是撞了保留字，
 * 不再混进 `bad_plugin_decl`）；其余形态问题仍归 `bad_plugin_decl`。
 * 保留名清单由 `common/framework-commands.ts` 单点定义，与 CLI 派发同源。
 */
function parseCommands(v: Json | undefined): ParseCommandsResult {
  if (!Array.isArray(v)) return { ok: false, reason: 'bad_plugin_decl' }
  const out: PluginCommand[] = []
  for (const item of v) {
    if (!isRecord(item)) return { ok: false, reason: 'bad_plugin_decl' }
    const { name, entry, argsSchema, readonly } = item
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, reason: 'bad_plugin_decl' }
    }
    if (FRAMEWORK_COMMAND_NAME_SET.has(name)) {
      return { ok: false, reason: 'reserved_command_name' }
    }
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, reason: 'bad_plugin_decl' }
    }
    if (argsSchema !== undefined && typeof argsSchema !== 'string') {
      return { ok: false, reason: 'bad_plugin_decl' }
    }
    // 缺省 false；显式给出必须是布尔（非布尔入世拒，不静默转换）
    if (readonly !== undefined && typeof readonly !== 'boolean') {
      return { ok: false, reason: 'bad_plugin_decl' }
    }
    const command: PluginCommand = { name, entry, readonly: readonly ?? false }
    if (argsSchema !== undefined) command.argsSchema = argsSchema
    out.push(command)
  }
  return { ok: true, commands: out }
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
 * 解析 `build` 声明：字段必需，缺失 → `null`（入世拒 `bad_plugin_decl`）；畸形 → `null`。
 * 每步形如 `{cmd, args}`，`cmd` 非空、`args` 为令牌白名单内的字符串数组。
 */
function parseBuild(v: Json | undefined): PluginBuildStep[] | null {
  if (v === undefined) return null
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

/** 资源类名形态上限：非空、限长、非 JS 原型键（作对象键会命中原型成员）。 */
const EXCLUSIVE_RESOURCE_NAME_MAX = 64 /**
 * 解析 `exclusive` 声明：缺失 → `undefined`（无独占资源）；畸形 → `null`（入世拒）。
 * 资源类名开放（`gpu` / `lock` / `singleton` 等皆可）：宿主对 `exclusive` 只做「非空即走独占换人序」，
 * 不需要理解资源类语义，故只校验形态（非空、限长、非原型键），不查该资源是否真的被占用。
 * 唯一的语义交叉校验在 `parsePluginDecl`：`data` 类要求 `state === 'durable'`。
 */
function parseExclusive(v: Json | undefined): string[] | null | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > EXCLUSIVE_RESOURCE_NAME_MAX ||
      PROTOTYPE_KEYS.has(item)
    ) {
      return null
    }
    out.push(item)
  }
  return out
}

/** 非空且无重复的字符串数组（能力类方法契约的形态要求）。 */
function isNonEmptyUniqueStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && new Set(value).size === value.length
}

/** 两个字符串数组是否同集合（忽略顺序与重复）。 */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a)
  if (set.size !== new Set(b).size) return false
  return b.every((item) => set.has(item))
}

/** 能力类名形态：非空、非原型键、非宿主保留类 `host`。 */
function isCapabilityKey(key: string): boolean {
  return key.length > 0 && !PROTOTYPE_KEYS.has(key) && key !== HOST_CAPABILITY
}

/**
 * 解析 `needs`：缺失 → `{}`（零扰动）；形态非法 → `null`（入世拒 `bad_plugin_decl`）。
 * 只查形状与声明期冲突：`many` 是否真有契约（本包 `methods` 或世界某拥有方 `slots`）在世界层，
 * decl 看不到他人声明，故该规则由入世期按能力索引判定。
 * 键冲突口径：`needs` 键不得与 `pins` / `implements` / `methods` 键重叠——自能力路径与槽路径互斥，
 * 也据此禁「同一能力类既 implements 又 needs」。
 */
function parseNeeds(
  value: Json | undefined,
  pins: Record<string, string>,
  implementsCaps: string[],
  methods: Record<string, string[]>,
): Record<string, NeedDecl> | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const implementsSet = new Set(implementsCaps)
  const out: Record<string, NeedDecl> = {}
  for (const cap of Object.keys(value)) {
    if (!isCapabilityKey(cap)) return null
    if (Object.hasOwn(pins, cap)) return null
    if (implementsSet.has(cap)) return null
    if (Object.hasOwn(methods, cap)) return null
    const entry = value[cap]
    if (!isRecord(entry)) return null
    for (const field of Object.keys(entry)) {
      if (field !== 'mode' && field !== 'methods') return null
    }
    const mode = entry['mode']
    if (mode !== 'one' && mode !== 'many') return null
    const need: NeedDecl = { mode }
    const declared = entry['methods']
    if (declared !== undefined) {
      if (!isNonEmptyUniqueStringArray(declared)) return null
      need.methods = declared
    }
    out[cap] = need
  }
  return out
}

/**
 * 解析 `slots`：缺失 → `{}`（零扰动）；形态非法 → `null`（入世拒 `bad_plugin_decl`）。
 * `methods` 是拥有方声明的契约全集（非空、无重复）；同给 `methods[cap]` 时须与它同集合。
 */
function parseSlots(
  value: Json | undefined,
  pins: Record<string, string>,
  methods: Record<string, string[]>,
): Record<string, SlotDecl> | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const out: Record<string, SlotDecl> = {}
  for (const cap of Object.keys(value)) {
    if (!isCapabilityKey(cap)) return null
    if (Object.hasOwn(pins, cap)) return null
    const entry = value[cap]
    if (!isRecord(entry)) return null
    for (const field of Object.keys(entry)) {
      if (field !== 'methods') return null
    }
    const contract = entry['methods']
    if (!isNonEmptyUniqueStringArray(contract)) return null
    const declared = methods[cap]
    if (declared !== undefined && !sameStringSet(declared, contract)) return null
    out[cap] = { methods: contract }
  }
  return out
}

/** 同语言（TS/JS）入口模块扩展名：`inproc` / `worker` 只接受这类入口。 */
const SAME_LANGUAGE_ENTRY = /\.(mjs|cjs|js|mts|cts|ts|jsx|tsx)$/i

/**
 * 同语言入口模块路径：非空、无空白、安全的包内相对路径、以 TS/JS 扩展名结尾。
 * `inproc` / `worker` 把入口载入宿主同进程 / worker，异语言代码无法这样加载，故 fail-closed。
 */
function isSameLanguageEntry(start: string): boolean {
  const entry = start.trim()
  if (entry.length === 0) return false
  if (/\s/.test(entry)) return false
  if (!isSafeRelativePath(entry)) return false
  return SAME_LANGUAGE_ENTRY.test(entry)
}

/**
 * 解析 `transport`：缺失 → `undefined`（由调用方回落 `stdio`，存量行为不变）；畸形 → `null`（入世拒）。
 * `inproc` / `worker` 之间**无缺省**，插件须显式声明其一，且 `start` 必须是同语言入口模块路径。
 */
function parseTransport(
  value: Json | undefined,
  start: string,
): ServiceTransport | null | undefined {
  if (value === undefined) return undefined
  if (value !== 'stdio' && value !== 'inproc' && value !== 'worker') return null
  if (value === 'stdio') return value
  return isSameLanguageEntry(start) ? value : null
}

/**
 * 宿主侧 `plugin.json` 元 schema：必需字段一个不少、类型正确、枚举合法
 * （`state` 两档：`recomputable` / `durable`，成员 `kind` 只认 `execute` / `term` / `schema`）；
 * `schema` 可省略 / 空串（零 schema，无世界数据的 UI 插件用），显式非字符串仍拒；
 * `build` 是必需字段（宿主不解释语言，声明是唯一构建来源），逐令牌过 shell 安全白名单；
 * `needs` / `slots` 可选（省略为空表，存量插件零扰动），只查形状与声明期冲突。
 * 只查形状，不查语义（实现正确性、业务含义一律不在本层）。
 */
export function parsePluginDecl(value: Json): ParseDeclResult {
  if (!isRecord(value)) return { ok: false, reasons: ['bad_plugin_decl'] }
  const commandsResult = parseCommands(value['commands'])
  if (!commandsResult.ok) return { ok: false, reasons: [commandsResult.reason] }
  const commands = commandsResult.commands
  const members = parseMembers(value['members'])
  const build = parseBuild(value['build'])
  const exclusive = parseExclusive(value['exclusive'])
  const transport = parseTransport(
    value['transport'],
    typeof value['start'] === 'string' ? value['start'] : '',
  )
  // `schema` 可省略或空串（零 schema 合法）；显式非字符串（含 null）仍拒——「直接省略」是唯一写法。
  const rawSchema = value['schema']
  const schema = typeof rawSchema === 'string' && rawSchema.length > 0 ? rawSchema : null
  const state = value['state']
  const stateOk = state === 'recomputable' || state === 'durable'
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
    stateOk &&
    members !== null &&
    build !== null &&
    exclusive !== null &&
    transport !== null
  if (!ok) return { ok: false, reasons: ['bad_plugin_decl'] }
  const methods = value['methods'] as Record<string, string[]>
  const pins = value['pins'] as Record<string, string>
  const implementsCaps = value['implements'] as string[]
  const needs = parseNeeds(value['needs'], pins, implementsCaps, methods)
  const slots = parseSlots(value['slots'], pins, methods)
  if (needs === null || slots === null) return { ok: false, reasons: ['bad_plugin_decl'] }
  // 拥有方消费自己的扩展点：`needs` 与自身 `slots` 同键时必须是 `many`（`one` 是单值绑定，
  // 与「开放扩展点」互斥）；`needs` / `slots` 与 `implements` 的互斥已在各自解析内判定。
  for (const cap of Object.keys(needs)) {
    if (Object.hasOwn(slots, cap) && needs[cap].mode !== 'many') {
      return { ok: false, reasons: ['bad_plugin_decl'] }
    }
  }
  // 交叉校验（按声明判，不看运行期目录是否已建）：声明独占 `data` 却非 `durable` 是自相矛盾——
  // 没有持久目录却声明独占持久存储，宿主无法给出对应的换人序语义。
  if ((exclusive ?? []).includes('data') && state !== 'durable') {
    return { ok: false, reasons: ['bad_plugin_decl'] }
  }
  return {
    ok: true,
    decl: {
      identity: value['identity'] as string,
      schema,
      implements: implementsCaps,
      methods,
      pins,
      needs,
      slots,
      start: value['start'] as string,
      transport: transport ?? 'stdio',
      build: build as PluginBuildStep[],
      exclusive: exclusive ?? [],
      protocol: value['protocol'] as string,
      restart: value['restart'] as Json,
      health: value['health'] as Json,
      state: value['state'] as string,
      members: members as PluginMember[],
      commands,
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

/**
 * 读某世代的 `one` 绑定（`commit.body.meta.needs`，cap → 身份名）。
 * 形态不符（非对象 / 值非字符串）即视为无绑定返回空表；原型键跳过，避免命中继承成员。
 */
export function needsBindingsOf(world: World, gen: Gen): Record<string, string> {
  const body = world.defs[gen.payload]?.body
  const meta = isRecord(body) ? body['meta'] : undefined
  const raw = isRecord(meta) ? meta['needs'] : undefined
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const cap of Object.keys(raw)) {
    if (PROTOTYPE_KEYS.has(cap)) continue
    const value = raw[cap]
    if (typeof value !== 'string') return {}
    out[cap] = value
  }
  return out
}

/**
 * 该身份当前代码世代的**有效 pins**：声明 `pins` ∪ 该世代 `commit.body.meta.needs` 的 `one` 绑定
 * （cap → 被依赖身份名）；同名键声明 `pins` 优先（`one` 绑定不覆盖）。无代码世代 / 声明不可解析 → `null`。
 * 单一来源：投影 `ids.<id>.pins` 与宿主注入服务工厂上下文 `pins` 同调此函数，避免两处口径漂移。
 */
export function effectivePins(
  world: World,
  identityId: string,
  blobsDir?: string,
): Record<string, string> | null {
  const decl = readPluginDecl(world, identityId, blobsDir)
  if (decl === null) return null
  const merged: Record<string, string> = {}
  for (const name of Object.keys(decl.decl.pins)) merged[name] = decl.decl.pins[name]
  const bindings = needsBindingsOf(world, decl.gen)
  for (const name of Object.keys(bindings)) {
    if (!Object.hasOwn(merged, name)) merged[name] = bindings[name]
  }
  return merged
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
        readonly: cmd.readonly,
      })
    }
  }
  return out
}

/** 按命令名解析到入口 def；重名取身份 id 字典序最小者。 */
export function resolveCommand(world: World, name: string, blobsDir?: string): CommandDecl | null {
  return buildCommandIndex(world, blobsDir).byName.get(name) ?? null
}

/** 命令索引：命令列表 + `名字 → 命令` 映射，供宿主按链头缓存、避免每次线性全扫。 */
export interface CommandIndex {
  commands: CommandDecl[]
  byName: Map<string, CommandDecl>
}

/**
 * 建命令索引：一次解析全部命令，名字映射按首次出现（身份 id 升序）先到先得，
 * 与 `resolveCommand` 的「重名取字典序最小者」同口径。
 */
export function buildCommandIndex(world: World, blobsDir?: string): CommandIndex {
  const commands = listCommands(world, blobsDir)
  const byName = new Map<string, CommandDecl>()
  for (const command of commands) if (!byName.has(command.name)) byName.set(command.name, command)
  return { commands, byName }
}
