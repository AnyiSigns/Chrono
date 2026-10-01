// 能力类 `plugin` 的方法表：list / read / validate / write。
// 数据源与机械校验全经反向调用（port.call）交宿主：本服务不读投影、无写通道，write 只产计划。
// 可见性黑名单先过滤、后调宿主；validate 的 result_hash 缓存到 ③，write 机械比对后才产计划。
// `validate` 与 `write` 必须同住本插件：write 依赖 validate 写入 ③ 的 result_hash 凭据，跨身份会丢凭据。

import { BadArgsError } from 'plugin-sdk'
import { resolveLimits } from './config.ts'
import { parseIdentities } from './host.ts'
import { candidateKey, buildPackOps, measureFiles, parseCandidateDecl } from './pack.ts'
import { isRecord, nowOf, planOf, stringMap } from './plan.ts'
import { clearValidateCache, readValidateCache, writeValidateCache } from './state.ts'
import { isHidden } from './visibility.ts'
import { ToolError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'
import type { HostCaller, IdentityInfo } from './host.ts'

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

async function hostIdentities(host: HostCaller): Promise<IdentityInfo[]> {
  const result = await host.call('identities', {})
  if (!result.ok) throw new ToolError(result.code, result.message)
  return parseIdentities(result.value)
}

/**
 * 把候选源码字节经 `host.blob.put` 内容寻址落 CAS（幂等）。写计划的 blob 是**指针 def**
 * （`{kind:'blob',sha256,size}`），字节本体必须先在 ④ 就位，否则物化 `blob_missing`。失败即拒。
 */
async function stageBlobs(
  host: HostCaller,
  blobs: { sha256: string; bytes: Buffer }[],
): Promise<void> {
  for (const blob of blobs) {
    const result = await host.call('blob.put', { bytes: blob.bytes.toString('base64') })
    if (!result.ok) throw new ToolError(result.code, result.message)
  }
}

/** `plugin.list`：过滤可见性黑名单后的身份清单。 */
async function listTool(host: HostCaller, _args: Rec, _env: CallEnv): Promise<Json> {
  const list = await hostIdentities(host)
  return { list: list.filter((entry) => !isHidden(entry.id)) as unknown as Json[] }
}

/** `plugin.read`：黑名单先拒（不调宿主），否则转发 host.source.read。 */
async function readTool(host: HostCaller, args: Rec, _env: CallEnv): Promise<Json> {
  const identity = requireString(args, 'identity')
  const path = requireString(args, 'path')
  if (isHidden(identity)) throw new ToolError('hidden_identity', identity)
  const result = await host.call('source.read', { identity, path })
  if (!result.ok) throw new ToolError(result.code, result.message)
  return result.value
}

/** `plugin.validate`：转发宿主 dry-run，并把 result_hash 与解析出的 needs 写入 ③（键 = 候选树规范化哈希）。 */
async function validateTool(host: HostCaller, args: Rec, env: CallEnv): Promise<Json> {
  const identity = requireString(args, 'identity')
  const files = requireFiles(args)
  if (isHidden(identity)) throw new ToolError('hidden_identity', identity)
  enforceLimits(files)
  const result = await host.call('validate_package', { files })
  if (!result.ok) throw new ToolError(result.code, result.message)
  const report = isRecord(result.value) ? result.value : {}
  const ok = report['ok'] === true
  const errors = Array.isArray(report['errors']) ? (report['errors'] as Json[]) : []
  const resultHash = typeof report['result_hash'] === 'string' ? report['result_hash'] : null
  const needs = stringMap(report['needs'])
  const key = candidateKey(files)
  if (resultHash !== null) {
    writeValidateCache(key, { identity, result_hash: resultHash, at: nowOf(env), needs })
  } else {
    clearValidateCache(key)
  }
  return { ok, errors, result_hash: resultHash, candidate_hash: key }
}

/**
 * 校验候选 `plugin.json` 的 pins：`host` 保留字面量，其余值即被依赖身份名（原样透传，不解析成哈希——
 * 宿主在落账段按身份名解析）。缺失 / 未激活的身份仍在此早退报 `unresolved_pin`，给作者及时反馈。
 */
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
    if (dep === undefined || dep.active === null) {
      throw new ToolError('unresolved_pin', depId)
    }
    pins[name] = depId
  }
  return pins
}

/**
 * `plugin.write`：只产写计划。强制顺序：候选树规范化哈希查 ③ 凭据，缺失 / commit 哈希不符
 * → `validate_required`；通过后按宿主入世同序产 put(blob)×n + put(tree) + put(commit) +
 * put(schema) + add_identity? + add_gen，批内 `{"$n":k}` 占位串起。
 */
async function writeTool(host: HostCaller, args: Rec, env: CallEnv): Promise<Json> {
  const identity = requireString(args, 'identity')
  const files = requireFiles(args)
  if (isHidden(identity)) throw new ToolError('hidden_identity', identity)
  enforceLimits(files)

  const key = candidateKey(files)
  let cached = readValidateCache(key)
  // 单调用便捷（opt-in）：auto_validate:true 且凭据缺失时先跑一次 validate，免去「先 validate 再 write」两次调用。
  // 凭据已存在则直接复用；显式 auto_validate 不改变 commit 哈希复核与原子 batch 语义。
  if (cached === null && args['auto_validate'] === true) {
    const report = await validateTool(host, { identity, files }, env)
    if (report['ok'] !== true) {
      const errors = Array.isArray(report['errors']) ? (report['errors'] as Json[]) : []
      const detail = errors.length > 0 ? JSON.stringify(errors[0]) : 'candidate validation failed'
      throw new ToolError('validate_failed', detail)
    }
    cached = readValidateCache(key)
  }
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
  const built = buildPackOps(files, decl.identity, decl, cached.needs)
  if (built.commitHash !== cached.result_hash) {
    clearValidateCache(key)
    throw new ToolError('validate_required', 'commit hash mismatch')
  }
  // 指针 blob 的字节本体先落 CAS，再产引用它们的写计划
  await stageBlobs(host, built.blobs)

  const identities = await hostIdentities(host)
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

function wrap(fn: (args: Rec, env: CallEnv) => Promise<Json>): Handler {
  return async (args: Json, env: CallEnv): Promise<HandlerResult> => {
    const record: Rec = isRecord(args) ? args : {}
    return { value: await fn(record, env), events: [] }
  }
}

/** 构造能力类 `plugin` 的方法表：SDK 派发器按方法名取用。 */
export function createHandlers(host: HostCaller): Record<string, Handler> {
  return {
    list: wrap((args, env) => listTool(host, args, env)),
    read: wrap((args, env) => readTool(host, args, env)),
    validate: wrap((args, env) => validateTool(host, args, env)),
    write: wrap((args, env) => writeTool(host, args, env)),
  }
}
