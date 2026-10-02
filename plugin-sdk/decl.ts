// `plugin.json` 声明解析的单一真源：字段表 + 形态校验 + 派生。
// 零内核零宿主依赖，宿主侧经 `packages/host/assembly/decl.ts` 传入生态 / 保留命令名 / 保留能力类后复用。
// 只做形态检查，不查语义（实现正确性、业务含义一律不在本层）；字段含义见 `docs/plugins.md`。

import { isRecord } from './json.ts'
import type { Json, Rec } from './json.ts'

/** 服务传输形态：`stdio`（缺省）/ `inproc` / `worker`。 */
export type ServiceTransport = 'stdio' | 'inproc' | 'worker'

/** `plugin.json.commands` 的一项。 */
export interface PluginCommand {
  name: string
  entry: string
  argsSchema?: string
  /** 只读命令：执行不广播 run 事件、不写审计 / 账本；缺省 false。 */
  readonly: boolean
}

/** `plugin.json.members` 的一项。 */
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

/**
 * `judgments` 的一个条目：`cap → method → 包内 term 路径`。
 * 该能力方法由 term 承载——宿主路由命中时**就地求值**该 term（不 spawn 服务），
 * 令判定成为可热改 / 可回滚 / 可审计的数据。
 */
export type JudgmentDecl = Record<string, Record<string, string>>

/** `plugin.json` 的解析结果；字段含义见插件规范，宿主只做形态检查。 */
export interface PluginDecl {
  identity: string
  /** 包内 schema 相对路径；省略 / 空串为 `null`（入世时用 `DEFAULT_SCHEMA_BODY`）。 */
  schema: string | null
  implements: string[]
  methods: Record<string, string[]>
  /** 消费方引用的能力类（`cap → 引用方式`）；省略为空表。 */
  needs: Record<string, NeedDecl>
  /** 拥有方声明契约的能力类（`cap → 方法契约`）；省略为空表。 */
  slots: Record<string, SlotDecl>
  /** 由 term 承载的能力方法（`cap → method → 包内 term 路径`）；省略为空表。 */
  judgments: JudgmentDecl
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

export type ParseDeclResult = { ok: true; decl: PluginDecl } | { ok: false; reasons: string[] }

/**
 * 解析环境：宿主特有的输入作为参数传入，令本模块保持零宿主依赖。
 * `entryExtensions` 判 `inproc` / `worker` 同语言入口；`reservedCommandNames` 判命令保留名；
 * `hostCapability` 是保留能力类名（不得作能力类键），也是 `needs` 里绑定宿主自身的哨兵键。
 */
export interface DeclParseEnv {
  entryExtensions: readonly string[]
  reservedCommandNames: ReadonlySet<string>
  hostCapability: string
}

/** 一个 `plugin.json` 字段的规范定义（名称 / 必填 / 简述），供文档生成与守护。 */
export interface PluginField {
  name: string
  required: boolean
  summary: string
}

/**
 * `plugin.json` 字段的单一手写真源（顺序即约定顺序）。
 * 文档（`docs/plugins-overview.md` / `docs/plugins.md` 生成段）与本表派生，禁止在别处复述字段清单。
 */
export const PLUGIN_DECL_FIELDS: readonly PluginField[] = [
  { name: 'identity', required: true, summary: '身份名 = 世界里的 `id`' },
  { name: 'schema', required: false, summary: '身份自述 / 数据契约的包内路径；可省略（零 schema）' },
  { name: 'implements', required: true, summary: '提供的能力类' },
  {
    name: 'methods',
    required: false,
    summary: '能力类 → 方法名；可省略（方法契约单源在拥有方 `slots`，缺省 `{}`）',
  },
  { name: 'concurrent_methods', required: false, summary: '并发安全的方法名；SDK 消费、宿主不读' },
  { name: 'needs', required: false, summary: '消费方引用的能力类（`one` / `many`）' },
  { name: 'slots', required: false, summary: '拥有方声明的能力类方法契约' },
  { name: 'judgments', required: false, summary: '由 term 承载的能力方法' },
  { name: 'start', required: true, summary: '启动命令；空 ≡ 无执行件（数据身份）' },
  { name: 'transport', required: false, summary: '服务传输形态：`stdio`（缺省）/ `inproc` / `worker`' },
  { name: 'build', required: true, summary: '构建声明 `[{cmd, args}]`；空数组 = 无需构建' },
  { name: 'exclusive', required: false, summary: '独占资源类；可省略' },
  { name: 'protocol', required: true, summary: '服务协议版本' },
  { name: 'restart', required: true, summary: '重启策略' },
  { name: 'health', required: true, summary: '健康判据' },
  { name: 'state', required: true, summary: '状态档：`recomputable` / `durable`' },
  { name: 'members', required: true, summary: '成员清单（`execute` / `term` / `schema`）' },
  { name: 'commands', required: true, summary: '命令声明 `{name, entry, argsSchema?, readonly?}`' },
]

/** 字段名清单（按约定顺序），供文档生成与一致性守护。 */
export const PLUGIN_DECL_FIELD_NAMES: readonly string[] = PLUGIN_DECL_FIELDS.map(
  (field) => field.name,
)

const REQUIRED_FIELD_NAMES: ReadonlySet<string> = new Set(
  PLUGIN_DECL_FIELDS.filter((field) => field.required).map((field) => field.name),
)

/**
 * JS 原型键：作为对象键会命中继承成员（`obj[key]` 不为 undefined），
 * 凡读取外部数据构造对象键 / 路径段处一律显式拒绝。
 */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** 字符串数组。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 把相对路径拆成路径段：空段与 `.` 丢弃，`..` 视为非法（返回 null）。 */
function pathSegments(relPath: string): string[] | null {
  const segments = relPath.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) return null
  return segments
}

/**
 * 包内相对路径是否安全（宽松口径）：非空、无绝对前缀 / 反斜杠 / 盘符、无 `..` 段。
 * 空段与 `.` 段被规范化丢弃。
 */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (path.includes('\\')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  const segments = pathSegments(path)
  return segments !== null && segments.length > 0
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

/** 能力类名形态：非空、非原型键、非宿主保留类。 */
function isCapabilityKey(key: string, hostCapability: string): boolean {
  return key.length > 0 && !PROTOTYPE_KEYS.has(key) && key !== hostCapability
}

type ParseCommandsResult = { ok: true; commands: PluginCommand[] } | { ok: false; reason: string }

/**
 * 解析命令声明：保留命令名给专用拒绝码 `reserved_command_name`（作者能看出是撞了保留字，
 * 不再混进 `bad_plugin_decl`）；其余形态问题仍归 `bad_plugin_decl`。
 * 保留名清单由调用方（宿主 `common/framework-commands.ts`）传入，与 CLI 派发同源。
 */
function parseCommands(v: Json | undefined, reserved: ReadonlySet<string>): ParseCommandsResult {
  if (!Array.isArray(v)) return { ok: false, reason: 'bad_plugin_decl' }
  const out: PluginCommand[] = []
  for (const item of v) {
    if (!isRecord(item)) return { ok: false, reason: 'bad_plugin_decl' }
    const { name, entry, argsSchema, readonly } = item
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, reason: 'bad_plugin_decl' }
    }
    if (reserved.has(name)) {
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
const EXCLUSIVE_RESOURCE_NAME_MAX = 64

/**
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

/**
 * 解析 `implements`：字符串数组，逐项须为合法能力类名（非空、非原型键、非保留类）且不得重复。
 * 非法 / 重复 → `null`（入世拒 `bad_plugin_decl`）：否则会静默退化成「声明实现但零端点」，
 * 或随原型键命中原型成员。与 `needs` / `slots` / `judgments` 的能力类名口径一致。
 */
function parseImplements(value: Json | undefined, hostCapability: string): string[] | null {
  if (!isStringArray(value)) return null
  const seen = new Set<string>()
  for (const cap of value) {
    if (!isCapabilityKey(cap, hostCapability)) return null
    if (seen.has(cap)) return null
    seen.add(cap)
  }
  return value
}

/**
 * 解析 `needs`：缺失 → `{}`（零扰动）；形态非法 → `null`（入世拒 `bad_plugin_decl`）。
 * 只查形状与声明期冲突：`many` 是否真有契约（本包 `methods` 或世界某拥有方 `slots`）在世界层，
 * decl 看不到他人声明，故该规则由入世期按能力索引判定。
 * 键冲突口径：`needs` 键不得与 `implements` / `methods` 键重叠——自能力路径与消费路径互斥。
 * 保留能力类 `host` 仅作**宿主依赖哨兵**允许出现在 `needs`：`mode` 必须是 `one`，
 * 入世时解析成自身（`host → host`），其余键仍须为合法能力类名。
 */
function parseNeeds(
  value: Json | undefined,
  implementsCaps: string[],
  methods: Record<string, string[]>,
  hostCapability: string,
): Record<string, NeedDecl> | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const implementsSet = new Set(implementsCaps)
  const out: Record<string, NeedDecl> = {}
  for (const cap of Object.keys(value)) {
    const isHost = cap === hostCapability
    if (!isHost && !isCapabilityKey(cap, hostCapability)) return null
    if (implementsSet.has(cap)) return null
    if (Object.hasOwn(methods, cap)) return null
    const entry = value[cap]
    if (!isRecord(entry)) return null
    for (const field of Object.keys(entry)) {
      if (field !== 'mode' && field !== 'methods') return null
    }
    const mode = entry['mode']
    if (mode !== 'one' && mode !== 'many') return null
    if (isHost && mode !== 'one') return null
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
  methods: Record<string, string[]>,
  hostCapability: string,
): Record<string, SlotDecl> | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const out: Record<string, SlotDecl> = {}
  for (const cap of Object.keys(value)) {
    if (!isCapabilityKey(cap, hostCapability)) return null
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

/**
 * 解析 `judgments`：缺失 → `{}`（零扰动）；形态非法 → `null`（入世拒 `bad_plugin_decl`）。
 * 每条 = `cap → method → 包内 term 路径`：`cap` 须 ∈ `implements`；本包有契约（`methods[cap]`，
 * 缺省回落本包 `slots[cap].methods`）时 `method` 须落在其内，两者皆无时契约住拥有方、由世界层判，
 * 故不在此拦；路径须是 `terms/` 下的安全相对 JSON 路径（`terms/` 成员在入世时已解析成 def）。
 */
function parseJudgments(
  value: Json | undefined,
  implementsCaps: string[],
  methods: Record<string, string[]>,
  slots: Record<string, SlotDecl>,
  hostCapability: string,
): JudgmentDecl | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const implementsSet = new Set(implementsCaps)
  const out: JudgmentDecl = {}
  for (const cap of Object.keys(value)) {
    if (!isCapabilityKey(cap, hostCapability) || !implementsSet.has(cap)) return null
    const contract = methods[cap] ?? slots[cap]?.methods
    const methodSet = contract === undefined ? null : new Set(contract)
    const entry = value[cap]
    if (!isRecord(entry)) return null
    const bound: Record<string, string> = {}
    for (const method of Object.keys(entry)) {
      if (methodSet !== null && !methodSet.has(method)) return null
      const path = entry[method]
      if (typeof path !== 'string' || path.length === 0) return null
      if (!path.startsWith('terms/') || !path.endsWith('.json')) return null
      if (!isSafeRelativePath(path)) return null
      bound[method] = path
    }
    if (Object.keys(bound).length === 0) return null
    out[cap] = bound
  }
  return out
}

/**
 * 同语言入口模块路径：非空、无任何空白（含首尾）、安全的包内相对路径、以生态声明的
 * 同语言扩展名结尾。`inproc` / `worker` 把入口载入宿主同进程 / worker，异语言代码无法这样加载，
 * 故 fail-closed。消费侧直接按原串解析，故校验**不得 trim**——首尾空白一经规范化放行，
 * 运行期仍用原串加载会得 `import_failed`，须在门禁当场拒。
 */
function isSameLanguageEntry(start: string, entryExtensions: readonly string[]): boolean {
  if (start.length === 0) return false
  if (/\s/.test(start)) return false
  if (!isSafeRelativePath(start)) return false
  const pattern = new RegExp(`\\.(${entryExtensions.join('|')})$`, 'i')
  return pattern.test(start)
}

/**
 * 解析 `transport`：缺失 → `undefined`（由调用方回落 `stdio`，存量行为不变）；畸形 → `null`（入世拒）。
 * `inproc` / `worker` 之间**无缺省**，插件须显式声明其一，且 `start` 必须是同语言入口模块路径。
 */
function parseTransport(
  value: Json | undefined,
  start: string,
  entryExtensions: readonly string[],
): ServiceTransport | null | undefined {
  if (value === undefined) return undefined
  if (value !== 'stdio' && value !== 'inproc' && value !== 'worker') return null
  if (value === 'stdio') return value
  return isSameLanguageEntry(start, entryExtensions) ? value : null
}

/**
 * 解析宿主侧 `plugin.json` 元 schema：必需字段一个不少、类型正确、枚举合法
 * （`state` 两档：`recomputable` / `durable`，成员 `kind` 只认 `execute` / `term` / `schema`）；
 * `schema` 可省略 / 空串（零 schema，无世界数据的 UI 插件用），显式非字符串仍拒；
 * `implements` 逐项须为合法能力类名（非空、非原型键、非保留类）且无重复；
 * `build` 是必需字段（宿主不解释语言，声明是唯一构建来源），逐令牌过 shell 安全白名单；
 * `needs` / `slots` / `methods` / `exclusive` / `transport` / `judgments` 可选，只查形状与声明期冲突；
 * `methods` 省略视为 `{}`（能力类方法契约单源在拥有方 `slots`，提供方无需复述）。
 * 只查形状，不查语义（实现正确性、业务含义一律不在本层）。
 */
export function parsePluginDecl(value: Json, env: DeclParseEnv): ParseDeclResult {
  if (!isRecord(value)) return { ok: false, reasons: ['bad_plugin_decl'] }
  for (const name of REQUIRED_FIELD_NAMES) {
    if (!Object.hasOwn(value, name)) return { ok: false, reasons: ['bad_plugin_decl'] }
  }
  const commandsResult = parseCommands(value['commands'], env.reservedCommandNames)
  if (!commandsResult.ok) return { ok: false, reasons: [commandsResult.reason] }
  const commands = commandsResult.commands
  const members = parseMembers(value['members'])
  const implementsCaps = parseImplements(value['implements'], env.hostCapability)
  if (implementsCaps === null) return { ok: false, reasons: ['bad_plugin_decl'] }
  const build = parseBuild(value['build'])
  const exclusive = parseExclusive(value['exclusive'])
  const transport = parseTransport(
    value['transport'],
    typeof value['start'] === 'string' ? value['start'] : '',
    env.entryExtensions,
  )
  // `schema` 可省略或空串（零 schema 合法）；显式非字符串（含 null）仍拒——「直接省略」是唯一写法。
  const rawSchema = value['schema']
  const schema = typeof rawSchema === 'string' && rawSchema.length > 0 ? rawSchema : null
  const state = value['state']
  const stateOk = state === 'recomputable' || state === 'durable'
  const ok =
    typeof value['identity'] === 'string' &&
    value['identity'].length > 0 &&
    value['identity'] !== env.hostCapability &&
    (rawSchema === undefined || typeof rawSchema === 'string') &&
    (value['methods'] === undefined ||
      (isRecord(value['methods']) && Object.values(value['methods']).every(isStringArray))) &&
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
  const methods = (value['methods'] ?? {}) as Record<string, string[]>
  const needs = parseNeeds(value['needs'], implementsCaps, methods, env.hostCapability)
  const slots = parseSlots(value['slots'], methods, env.hostCapability)
  if (needs === null || slots === null) return { ok: false, reasons: ['bad_plugin_decl'] }
  const judgments = parseJudgments(
    value['judgments'],
    implementsCaps,
    methods,
    slots,
    env.hostCapability,
  )
  if (judgments === null) return { ok: false, reasons: ['bad_plugin_decl'] }
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
      needs,
      slots,
      judgments,
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

/** 服务握手回带的 manifest（`docs/protocol.md` §2.1）。 */
export interface ServiceManifest {
  v: string
  identity: string
  implements: string[]
  methods: Record<string, string[]>
  protocol: string
  state: string
}

function stringList(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/**
 * 从已解析的 `plugin.json` 派生服务 manifest；缺声明按能力类 / 缺省状态档回落。
 * 字段口径与 `parsePluginDecl` 同源（同一份字段名与形态判定）。
 */
export function deriveManifest(
  plugin: Rec,
  capability: string,
  defaultState: string,
): ServiceManifest {
  const identity =
    typeof plugin['identity'] === 'string' ? (plugin['identity'] as string) : capability
  const implementsList = Array.isArray(plugin['implements'])
    ? stringList(plugin['implements'])
    : [capability]
  const methods = isRecord(plugin['methods']) ? (plugin['methods'] as Rec) : {}
  const protocol = typeof plugin['protocol'] === 'string' ? (plugin['protocol'] as string) : '1'
  const state = typeof plugin['state'] === 'string' ? (plugin['state'] as string) : defaultState
  return {
    v: '1',
    identity,
    implements: implementsList,
    methods: methods as Record<string, string[]>,
    protocol,
    state,
  }
}
