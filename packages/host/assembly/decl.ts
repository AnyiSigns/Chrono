// 声明解析（只读世界）：从世界里读 `plugin.json`、解析包内路径、列出 / 解析命令。
// 只解释 `plugin.json` 形状，不校验语义；其余包内文件一律是源码 blob。
// 字段表 + 校验 + 派生复用 `plugin-sdk/decl.ts` 的单一真源，本层只把宿主特有输入（生态 / 保留命令名 /
// 保留能力类）作为参数注入，保持宿主既有导出名与调用口径不变。

import { H } from '../../kernel/index.ts'
import { getBlob, isBlobPointer } from '../blobs.ts'
import { FRAMEWORK_COMMAND_NAME_SET } from '../common/framework-commands.ts'
import { isRecord, PROTOTYPE_KEYS } from '../common/json.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { parsePluginDecl as parsePluginDeclWithEnv } from '../../../plugin-sdk/decl.ts'
import type { ParseDeclResult, PluginDecl } from '../../../plugin-sdk/decl.ts'
import { DEFAULT_ECOSYSTEM } from './ecosystem.ts'
import type { EcosystemProfile } from './ecosystem.ts'
import { replaceTermRefs } from './term-refs.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

export {
  DEFAULT_SCHEMA_BODY,
  PLUGIN_DECL_FIELDS,
  PLUGIN_DECL_FIELD_NAMES,
} from '../../../plugin-sdk/decl.ts'
export type {
  JudgmentDecl,
  NeedDecl,
  NeedMode,
  ParseDeclResult,
  PluginBuildStep,
  PluginCommand,
  PluginDecl,
  PluginMember,
  SlotDecl,
  ServiceTransport,
} from '../../../plugin-sdk/decl.ts'

/**
 * 宿主侧 `plugin.json` 解析：把生态 profile 的同语言入口扩展名、框架保留命令名、宿主保留能力类名
 * 注入共享解析器，校验语义与字段表完全由 `plugin-sdk/decl.ts` 单点定义。
 */
export function parsePluginDecl(
  value: Json,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): ParseDeclResult {
  return parsePluginDeclWithEnv(value, {
    entryExtensions: ecosystem.entryExtensions,
    reservedCommandNames: FRAMEWORK_COMMAND_NAME_SET,
    hostCapability: HOST_CAPABILITY,
  })
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

/**
 * 读指定世代的 `plugin.json`；缺任一步返回 null（供换代比对按旧世代读声明）。
 * 不按世代记忆结果：声明读的成败取决于当前 `world.defs` 是否含 tree / entry / pointer def，
 * 而该「缺失」是可补齐的（同世界补齐 def 后重试须成功）——缓存正 / 负结果都会让补齐后的
 * 同世界重试失真。字节级去重由 `getBlob` 的内容寻址缓存承担（键 sha256、只在 def 在位时命中）。
 * `ecosystem` 与入世解析同源（同语言入口扩展名）；缺省内建默认，零行为变化。
 */
export function readPluginDeclOfGen(
  world: World,
  gen: Gen,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): DeclRead | null {
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
  const result = parsePluginDecl(parsed, ecosystem)
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
 * `ecosystem` 与入世解析同源；缺省内建默认，零行为变化。
 */
export function readPluginDecl(
  world: World,
  identityId: string,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): DeclRead | null {
  const identity = world.ids[identityId]
  if (!identity || identity.active === null) return null
  const gen = assemblyGen(world, identityId)
  if (gen === null) return null
  return readPluginDeclOfGen(world, gen, blobsDir, ecosystem)
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

/**
 * 解析 `judgments` 一条 term 路径的实际 def 哈希（`$ref` 递归替换、`sig` = 世代签名）。
 * 与命令入口同路；缺失 / 坏引用 / 成环返回 null（入世侧已把关）。
 */
export function resolveJudgmentHash(
  world: World,
  tree: Hash,
  relPath: string,
  sig: Hash,
  blobsDir?: string,
): Hash | null {
  return resolveTermHash(world, tree, relPath, sig, blobsDir)
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
