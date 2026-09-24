// 宿主保留能力类 `host` 的方法实现：audit / asset.put / asset.get / identities / source.read /
// validate_package / thread.terminate / thread.resume。宿主不解释业务，只做机械路由与内容寻址。
// 依赖以回调注入（世界快照 / 审计索引 / run 表），故本模块不直接持有宿主进程状态。

import { latestDataGen, readPluginDecl, resolveTreeEntry } from './assembly/index.ts'
import { getBlob, isBlobPointer, putBlob } from './blobs.ts'
import { reachableDefHashes } from './projection/index.ts'
import { getAsset, putAsset } from './assets.ts'
import { validatePackage } from './validate-package.ts'
import type { AuditQuery, AuditReport } from './audit.ts'
import { parseAuditFilter } from './audit.ts'
import type { EndpointCallResult } from './endpoint-table.ts'
import type { HostCapabilityCall } from './effect/index.ts'
import type { Hash, Json, World } from '../kernel/index.ts'

export interface HostCapabilityDeps {
  assetsDir: string
  /** 源码 CAS 目录：`source.read` 解析 pointer blob 时经它读字节。 */
  blobsDir: string
  /** 宿主运行态目录（③）：`validate_package` 的候选文件临时落点，用后即删。 */
  runtimeDir: string
  /** 只读审计查询面（侧存索引：启动时由侧存重建、运行期增量补齐）。 */
  audits: AuditQuery
  /** 当前世界快照（`source.read` 用；运行期随落账推进）。 */
  world: () => World
  /** 中止一个在册 run；未知 run 返回 false。 */
  abortRun: (run: string) => boolean
  /**
   * 启动一次 detached run（无 socket、结果不回流）：返回新 run id；
   * 并发超宿主上限 → `too_many_runs`（不起新 run）。`thread` 仅随事件原样回带。
   */
  startDetachedRun: (
    emitter: string,
    entry: Hash,
    args: Json,
    thread: string | null,
  ) => { ok: true; run: string } | { ok: false; code: 'too_many_runs' }
  /** 停机中：不再受理新 run。 */
  isStopping: () => boolean
}

function asRecord(value: Json | undefined): { [k: string]: Json } | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

function bad(code: string, message: string): EndpointCallResult {
  return { ok: false, code, message }
}

/** `audit { filter?, limit? }`：filter 与入站 audit 同形；limit 覆盖 filter.limit。 */
function auditCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args) ?? {}
  let filterInput: Json | undefined = record['filter']
  const limit = record['limit']
  if (limit !== undefined) {
    if (filterInput !== undefined && filterInput !== null) {
      const base = asRecord(filterInput)
      if (base === null) return bad('bad_directive', 'bad audit filter')
      filterInput = { ...base, limit }
    } else {
      filterInput = { limit }
    }
  }
  const filter = parseAuditFilter(filterInput)
  if (filter === null) return bad('bad_directive', 'bad audit filter')
  const report: AuditReport = deps.audits.query(filter)
  return {
    ok: true,
    value: { records: report.records as unknown as Json[], truncated: report.truncated },
  }
}

/** `asset.put { mime, bytes(base64) }`：内容寻址落宿主资产区，回世界侧引用。 */
function assetPutCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args)
  if (record === null) return bad('bad_asset', 'asset.put expects an object')
  const result = putAsset(deps.assetsDir, record['mime'], record['bytes'])
  if (!result.ok) return bad(result.code, 'asset put rejected')
  return { ok: true, value: result.ref as unknown as Json }
}

/** `asset.get { sha256 }`：读回字节与 mime；字节缺失 → `asset_missing`。 */
function assetGetCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args)
  const sha256 = record === null ? undefined : record['sha256']
  const result = getAsset(deps.assetsDir, sha256)
  if (!result.ok) return bad(result.code, typeof sha256 === 'string' ? sha256 : 'bad_asset')
  return { ok: true, value: { bytes: result.bytes, mime: result.mime, size: result.size } }
}

/** 单 blob 原始字节上限（与 `asset.put` 同口径：base64 ≈ 10.67MiB < 单帧 16MiB）。 */
const MAX_BLOB_BYTES = 8 * 1024 * 1024

/**
 * `blob.put { bytes(base64) }`：把源码字节内容寻址落 CAS，回 pointer def body `{kind:'blob',sha256,size}`。
 * 供上层（如 plugin-admin 的写计划）在 `put(pointer)` 前把字节本体交给宿主——① 只存指针，字节住 ④。
 */
function blobPutCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args)
  const bytes = record === null ? undefined : record['bytes']
  if (typeof bytes !== 'string') return bad('bad_blob', 'blob.put expects { bytes(base64) }')
  const decoded = Buffer.from(bytes, 'base64')
  // 只收规范 base64（往返一致才认），与 asset.put 同口径
  if (decoded.toString('base64') !== bytes) return bad('bad_blob', 'non-canonical base64')
  if (decoded.length > MAX_BLOB_BYTES) return bad('blob_too_large', 'blob exceeds limit')
  const result = putBlob(deps.blobsDir, decoded)
  if (!result.ok) return bad(result.code, 'blob put rejected')
  return { ok: true, value: result.pointer as unknown as Json }
}

/** 读一个 blob 的 base64 内容与字节长度：pointer 经 CAS，inline 文本现编码、base64 原样。 */
function blobBytes(
  def: { body?: Json; enc?: Json } | undefined,
  blobsDir: string,
): { content: string; size: number } | null {
  const body = def?.body
  if (isBlobPointer(body)) {
    const read = getBlob(blobsDir, body)
    if (!read.ok) return null
    return { content: read.bytes.toString('base64'), size: read.bytes.length }
  }
  if (typeof body !== 'string') return null
  if (def?.enc === 'base64') return { content: body, size: Buffer.from(body, 'base64').length }
  return {
    content: Buffer.from(body, 'utf8').toString('base64'),
    size: Buffer.byteLength(body, 'utf8'),
  }
}

/**
 * `identities {}`：只读身份清单面——宿主从世界 + 各身份**当前代码世代声明**机械读出
 * `id` / `active` / `implements` / `commands`（命令只出名字）；不解释业务，不含 `pins` 明细。
 */
function identitiesCall(deps: HostCapabilityDeps): EndpointCallResult {
  const world = deps.world()
  const list: Json[] = []
  for (const id of Object.keys(world.ids).sort()) {
    const read = readPluginDecl(world, id, deps.blobsDir)
    list.push({
      id,
      active: world.ids[id].active,
      implements: read === null ? [] : read.decl.implements,
      commands: read === null ? [] : read.decl.commands.map((command) => command.name),
    })
  }
  return { ok: true, value: { list } }
}

/** 单次 `def.read` 的哈希数上限（防一次拉爆帧与内存）。 */
const DEF_READ_MAX_HASHES = 256

/** 单次 `def.read` 返回 body 的字节上限（序列化后计；超出即截断并标记）。 */
const DEF_READ_MAX_BYTES = 4 * 1024 * 1024

/** 越权门禁的闭包缓存条目上限（按「身份 + 投影 body 哈希」缓存，body 不可变 ⇒ 命中可复用）。 */
const DEF_SCOPE_CACHE_MAX = 64

const HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * `def.read { identity, hashes }`：按哈希只读解析 def body——投影只回引用，消费方按需取 body。
 * 只读、有界（单次哈希数 / 返回字节数）、越权 fail-closed：只放行从该身份投影 body 可达的 def；
 * 形态非法直接拒，越权 / 缺失进 `denied` / `missing`，超出字节上限进 `missing` 并置 `truncated`。
 */
function defReadCall(
  deps: HostCapabilityDeps,
  args: Json,
  scopeCache: Map<string, Set<Hash>>,
): EndpointCallResult {
  const record = asRecord(args)
  const identity = record === null ? undefined : record['identity']
  const hashes = record === null ? undefined : record['hashes']
  if (typeof identity !== 'string' || identity.length === 0) {
    return bad('bad_directive', 'def.read expects { identity, hashes }')
  }
  if (!Array.isArray(hashes)) return bad('bad_directive', 'def.read expects hashes array')
  if (hashes.length > DEF_READ_MAX_HASHES) return bad('def_read_too_many', 'too many hashes')
  const world = deps.world()
  const identityEntry = world.ids[identity]
  if (identityEntry === undefined) return bad('not_found', identity)
  const bodyHash = latestDataGen(world, identity)?.payload ?? identityEntry.active
  const body = bodyHash === null ? undefined : world.defs[bodyHash]?.body
  if (bodyHash === null || body === undefined) return bad('not_found', identity)
  const cacheKey = `${identity}\u0000${bodyHash}`
  let allowed = scopeCache.get(cacheKey)
  if (allowed === undefined) {
    allowed = reachableDefHashes(world, body)
    if (scopeCache.size >= DEF_SCOPE_CACHE_MAX) {
      const oldest = scopeCache.keys().next().value
      if (oldest !== undefined) scopeCache.delete(oldest)
    }
    scopeCache.set(cacheKey, allowed)
  }
  const defs: { [hash: string]: Json } = {}
  const missing: Hash[] = []
  const denied: Hash[] = []
  let bytes = 0
  let truncated = false
  for (const raw of hashes) {
    if (typeof raw !== 'string' || !HASH_PATTERN.test(raw)) {
      return bad('bad_directive', 'def.read expects 64-hex hashes')
    }
    if (Object.hasOwn(defs, raw)) continue
    if (!allowed.has(raw)) {
      denied.push(raw)
      continue
    }
    const def = world.defs[raw]
    if (def === undefined) {
      missing.push(raw)
      continue
    }
    const size = JSON.stringify(def.body)?.length ?? 0
    if (bytes + size > DEF_READ_MAX_BYTES) {
      truncated = true
      missing.push(raw)
      continue
    }
    defs[raw] = def.body
    bytes += size
  }
  return { ok: true, value: { defs, missing, denied, truncated } }
}

/** `source.read { identity, path }`：按路径读某身份源码 blob（只读；目录 / 缺失 → `not_found`）。 */
function sourceReadCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args)
  const identity = record === null ? undefined : record['identity']
  const path = record === null ? undefined : record['path']
  if (typeof identity !== 'string' || typeof path !== 'string') {
    return bad('not_found', 'source.read expects { identity, path }')
  }
  const world = deps.world()
  const read = readPluginDecl(world, identity, deps.blobsDir)
  if (read === null) return bad('not_found', identity)
  const entry = resolveTreeEntry(world, read.tree, path)
  if (entry === null || entry.mode !== 'file') return bad('not_found', path)
  const bytes = blobBytes(world.defs[entry.hash] as { body?: Json; enc?: Json } | undefined, deps.blobsDir)
  if (bytes === null) return bad('not_found', path)
  return { ok: true, value: { path, content: bytes.content, size: bytes.size } }
}

/** `validate_package { files }`：按入世同一套机械校验 dry-run 候选包，不写世界。 */
function validatePackageCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args)
  const files = record === null ? undefined : record['files']
  const outcome = validatePackage(deps.world(), deps.runtimeDir, files ?? null, deps.blobsDir)
  if (!outcome.accepted) return bad('bad_directive', outcome.message)
  return { ok: true, value: outcome.report as unknown as Json }
}

/** `thread.terminate { run }`：等价 `cancel{run}`；未知 / 已结束 → `unknown_run`。 */
function threadTerminateCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args)
  const run = record === null ? undefined : record['run']
  if (typeof run !== 'string' || run.length === 0) {
    return bad('unknown_run', 'thread.terminate expects run')
  }
  if (!deps.abortRun(run)) return bad('unknown_run', run)
  return { ok: true, value: { ok: true } }
}

/** `thread.resume { entry, args?, thread? }`：启动 detached run，立即回新 run id；游标语义归调用方。 */
function threadResumeCall(
  deps: HostCapabilityDeps,
  emitter: string,
  args: Json,
): EndpointCallResult {
  if (deps.isStopping()) return bad('internal', 'stopping')
  const record = asRecord(args)
  const entry = record === null ? undefined : record['entry']
  if (typeof entry !== 'string' || entry.length === 0) {
    return bad('bad_directive', 'thread.resume expects entry')
  }
  // thread 缺省 null：仅随 detached run 生命周期事件原样回带，宿主不解释
  const thread = record !== null && typeof record['thread'] === 'string' ? record['thread'] : null
  const started = deps.startDetachedRun(emitter, entry, record?.['args'] ?? null, thread)
  if (!started.ok) return bad(started.code, 'too many detached runs')
  return { ok: true, value: { run: started.run } }
}

/** 组装宿主保留能力类派发器；方法集由 `HOST_METHODS` 固定，未知方法 fail-closed。 */
export function createHostCapability(deps: HostCapabilityDeps): HostCapabilityCall {
  const defScopeCache = new Map<string, Set<Hash>>()
  return async (method, emitter, args) => {
    switch (method) {
      case 'audit':
        return auditCall(deps, args)
      case 'asset.put':
        return assetPutCall(deps, args)
      case 'asset.get':
        return assetGetCall(deps, args)
      case 'blob.put':
        return blobPutCall(deps, args)
      case 'def.read':
        return defReadCall(deps, args, defScopeCache)
      case 'identities':
        return identitiesCall(deps)
      case 'source.read':
        return sourceReadCall(deps, args)
      case 'thread.terminate':
        return threadTerminateCall(deps, args)
      case 'thread.resume':
        return threadResumeCall(deps, emitter, args)
      case 'validate_package':
        return validatePackageCall(deps, args)
      default:
        return bad('not_loaded', method)
    }
  }
}
