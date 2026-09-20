// 宿主保留能力类 `host` 的方法实现：audit / asset.put / asset.get / source.read /
// validate_package / thread.terminate / thread.resume。宿主不解释业务，只做机械路由与内容寻址。
// 依赖以回调注入（世界快照 / 审计索引 / run 表），故本模块不直接持有宿主进程状态。

import { readPluginDecl, resolveTreeEntry } from './assembly/index.ts'
import { getAsset, putAsset } from './assets.ts'
import { validatePackage } from './validate-package.ts'
import type { AuditIndex, AuditReport } from './audit.ts'
import { parseAuditFilter } from './audit.ts'
import type { EndpointCallResult } from './endpoint-table.ts'
import type { HostCapabilityCall } from './effect/index.ts'
import type { Hash, Json, World } from '../kernel/index.ts'

export interface HostCapabilityDeps {
  assetsDir: string
  /** 宿主运行态目录（③）：`validate_package` 的候选文件临时落点，用后即删。 */
  runtimeDir: string
  /** 只读审计索引（启动时重建、运行期增量补齐）。 */
  audits: AuditIndex
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

/** 读一个 blob 的 base64 内容与字节长度：文本 blob 现编码，base64 blob 原样。 */
function blobBytes(
  def: { body?: Json; enc?: Json } | undefined,
): { content: string; size: number } | null {
  const body = def?.body
  if (typeof body !== 'string') return null
  if (def?.enc === 'base64') return { content: body, size: Buffer.from(body, 'base64').length }
  return {
    content: Buffer.from(body, 'utf8').toString('base64'),
    size: Buffer.byteLength(body, 'utf8'),
  }
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
  const read = readPluginDecl(world, identity)
  if (read === null) return bad('not_found', identity)
  const entry = resolveTreeEntry(world, read.tree, path)
  if (entry === null || entry.mode !== 'file') return bad('not_found', path)
  const bytes = blobBytes(world.defs[entry.hash] as { body?: Json; enc?: Json } | undefined)
  if (bytes === null) return bad('not_found', path)
  return { ok: true, value: { path, content: bytes.content, size: bytes.size } }
}

/** `validate_package { files }`：按入世同一套机械校验 dry-run 候选包，不写世界。 */
function validatePackageCall(deps: HostCapabilityDeps, args: Json): EndpointCallResult {
  const record = asRecord(args)
  const files = record === null ? undefined : record['files']
  const outcome = validatePackage(deps.world(), deps.runtimeDir, files ?? null)
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
  return async (method, emitter, args) => {
    switch (method) {
      case 'audit':
        return auditCall(deps, args)
      case 'asset.put':
        return assetPutCall(deps, args)
      case 'asset.get':
        return assetGetCall(deps, args)
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
