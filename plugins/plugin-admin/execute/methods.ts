// 能力类方法表：`plugin`[list, read, validate, write] + `plugin-admin`[describe, invoke]。
// 数据源与机械校验全经反向调用（port.call）交宿主：本服务不读投影、无写通道，write 只产计划。
// 可见性黑名单先过滤、后调宿主；validate 的 result_hash 缓存到 ③，write 机械比对后才产计划。

import { resolveLimits } from './config.ts'
import { HostLink, parseIdentities } from './host.ts'
import { candidateKey, buildPackOps, measureFiles, parseCandidateDecl } from './pack.ts'
import { isRecord, nowOf, planOf } from './plan.ts'
import { clearValidateCache, readValidateCache, writeValidateCache } from './state.ts'
import { describeValue } from './tools.ts'
import { isHidden } from './visibility.ts'
import { BadArgsError, ToolError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, HostResult, Json, Rec } from './types.ts'
import type { IdentityInfo } from './host.ts'

/** 本连接的反向调用登记表；main.ts 收到 port.result / port.error 时调 `HOST.resolve`。 */
export const HOST = new HostLink()

const LIMITS = resolveLimits()

function requireString(args: Rec, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new BadArgsError(`${key} required`)
  return value
}

function requireFiles(args: Rec): Rec {
  const files = args['files']
  if (!isRecord(files)) throw new BadArgsError('files must be an object')
  return files
}

function enforceLimits(files: Rec): void {
  const { fileCount, totalBytes } = measureFiles(files)
  if (fileCount > LIMITS.maxFiles) throw new ToolError('too_many_files', `${fileCount} files`)
  if (totalBytes > LIMITS.maxSourceBytes) {
    throw new ToolError('source_too_large', `${totalBytes} bytes`)
  }
}

async function hostIdentities(): Promise<IdentityInfo[]> {
  const result = await HOST.call('identities', {})
  if (!result.ok) throw new ToolError(result.code, result.message)
  return parseIdentities(result.value)
}

/**
 * 把候选源码字节经 `host.blob.put` 内容寻址落 CAS（幂等）。写计划的 blob 是**指针 def**
 * （`{kind:'blob',sha256,size}`），字节本体必须先在 ④ 就位，否则物化 `blob_missing`。失败即拒。
 */
async function stageBlobs(blobs: { sha256: string; bytes: Buffer }[]): Promise<void> {
  for (const blob of blobs) {
    const result = await HOST.call('blob.put', { bytes: blob.bytes.toString('base64') })
    if (!result.ok) throw new ToolError(result.code, result.message)
  }
}

/** `plugin.list`：过滤可见性黑名单后的身份清单。 */
async function listTool(_args: Rec, _env: CallEnv): Promise<Json> {
  const list = await hostIdentities()
  return { list: list.filter((entry) => !isHidden(entry.id)) as unknown as Json[] }
}

/** `plugin.read`：黑名单先拒（不调宿主），否则转发 host.source.read。 */
async function readTool(args: Rec, _env: CallEnv): Promise<Json> {
  const identity = requireString(args, 'identity')
  const path = requireString(args, 'path')
  if (isHidden(identity)) throw new ToolError('hidden_identity', identity)
  const result: HostResult = await HOST.call('source.read', { identity, path })
  if (!result.ok) throw new ToolError(result.code, result.message)
  return result.value
}

/** `plugin.validate`：转发宿主 dry-run，并把 result_hash 写入 ③（键 = 候选树规范化哈希）。 */
async function validateTool(args: Rec, env: CallEnv): Promise<Json> {
  const identity = requireString(args, 'identity')
  const files = requireFiles(args)
  if (isHidden(identity)) throw new ToolError('hidden_identity', identity)
  enforceLimits(files)
  const result = await HOST.call('validate_package', { files })
  if (!result.ok) throw new ToolError(result.code, result.message)
  const report = isRecord(result.value) ? result.value : {}
  const ok = report['ok'] === true
  const errors = Array.isArray(report['errors']) ? (report['errors'] as Json[]) : []
  const resultHash = typeof report['result_hash'] === 'string' ? report['result_hash'] : null
  const key = candidateKey(files)
  if (resultHash !== null) {
    writeValidateCache(key, { identity, result_hash: resultHash, at: nowOf(env) })
  } else {
    clearValidateCache(key)
  }
  return { ok, errors, result_hash: resultHash, candidate_hash: key }
}

/** 解析候选 plugin.json 的 pins：`host` 保留字面量，其余解析到被依赖身份 active 世代。 */
function resolvePins(
  declared: Record<string, string>,
  identities: IdentityInfo[],
): Record<string, string> {
  const byId = new Map(identities.map((entry) => [entry.id, entry]))
  const pins: Record<string, string> = {}
  for (const [name, depId] of Object.entries(declared)) {
    if (depId === 'host') {
      pins[name] = 'host'
      continue
    }
    const dep = byId.get(depId)
    if (dep === undefined || typeof dep.active !== 'string') {
      throw new ToolError('unresolved_pin', depId)
    }
    pins[name] = dep.active
  }
  return pins
}

/**
 * `plugin.write`：只产写计划。强制顺序：候选树规范化哈希查 ③ 凭据，缺失 / commit 哈希不符
 * → `validate_required`；通过后按宿主入世同序产 put(blob)×n + put(tree) + put(commit) +
 * put(schema) + add_identity? + add_gen，批内 `{"$n":k}` 占位串起。
 */
async function writeTool(args: Rec, _env: CallEnv): Promise<Json> {
  const identity = requireString(args, 'identity')
  const files = requireFiles(args)
  if (isHidden(identity)) throw new ToolError('hidden_identity', identity)
  enforceLimits(files)

  const key = candidateKey(files)
  const cached = readValidateCache(key)
  if (cached === null) throw new ToolError('validate_required', 'no validate result for tree')
  // 调用方若把上次 validate 的 result_hash 带回，则与 ③ 凭据机械比对（防陈旧 / 张冠李戴）
  const carried = args['result_hash']
  if (typeof carried === 'string' && carried !== cached.result_hash) {
    throw new ToolError('validate_required', 'carried result_hash mismatch')
  }

  const decl = parseCandidateDecl(files)
  if (decl.identity !== identity) {
    throw new ToolError('identity_mismatch', `${identity} != ${decl.identity}`)
  }
  const built = buildPackOps(files, decl.identity, decl)
  if (built.commitHash !== cached.result_hash) {
    clearValidateCache(key)
    throw new ToolError('validate_required', 'commit hash mismatch')
  }
  // 指针 blob 的字节本体先落 CAS，再产引用它们的写计划
  await stageBlobs(built.blobs)

  const identities = await hostIdentities()
  const isNew = !identities.some((entry) => entry.id === identity)
  const pins = resolvePins(decl.pins, identities)

  const ops = [...built.ops]
  if (isNew) {
    ops.push({ op: 'add_identity', args: { id: identity, schema: { $n: built.schemaIndex } } })
  }
  ops.push({
    op: 'add_gen',
    args: {
      id: identity,
      payload: { $n: built.commitIndex },
      sig: { $n: built.commitIndex },
      pins,
    },
  })

  return planOf(ops, {
    ok: true,
    identity,
    commit: built.commitHash,
    candidate_hash: key,
    files: built.fileCount,
    new_identity: isNew,
  })
}

/** `plugin-admin.describe`：回四工具 + 四要素 + render 描述符。 */
async function describeTool(_args: Rec, _env: CallEnv): Promise<Json> {
  return describeValue()
}

/** `plugin-admin.invoke`：按工具名派发；业务失败作 `{ok:false,error}` 值（不炸本轮）。 */
async function invokeTool(args: Rec, env: CallEnv): Promise<Json> {
  const tool = requireString(args, 'tool')
  const toolArgs = isRecord(args['args']) ? (args['args'] as Rec) : {}
  try {
    const value = await dispatch(tool, toolArgs, env)
    return { ok: true, result: value }
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    if (err instanceof BadArgsError) {
      return { ok: false, error: { code: 'bad_args', message: err.message } }
    }
    throw err
  }
}

/** 工具名 → 实现（invoke 的派发表；未知工具 `unknown_tool`）。 */
async function dispatch(tool: string, args: Rec, env: CallEnv): Promise<Json> {
  switch (tool) {
    case 'plugin.list':
      return listTool(args, env)
    case 'plugin.read':
      return readTool(args, env)
    case 'plugin.validate':
      return validateTool(args, env)
    case 'plugin.write':
      return writeTool(args, env)
    default:
      throw new ToolError('unknown_tool', tool)
  }
}

function wrap(fn: (args: Rec, env: CallEnv) => Promise<Json>): Handler {
  return async (args: Json, env: CallEnv): Promise<HandlerResult> => {
    const record: Rec = isRecord(args) ? args : {}
    return { value: await fn(record, env) }
  }
}

/** 按端口分组的方法表：main.ts 校验 `port` / `method` 后取用。 */
export const PORT_HANDLERS: Record<string, Record<string, Handler>> = {
  plugin: {
    list: wrap(listTool),
    read: wrap(readTool),
    validate: wrap(validateTool),
    write: wrap(writeTool),
  },
  'plugin-admin': {
    describe: wrap(describeTool),
    invoke: wrap(invokeTool),
  },
}
