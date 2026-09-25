// 能力类 `compress` 的方法表：summarize / compact / extract。
// 压缩产物（L1 / L2 摘要）是运行记录，已出世界：住 `short-memory` owner 服务自有存储（④）。
// 本服务经 `port.call short-memory.read` 取现状、算合并结果后 `port.call short-memory.apply` 写回；
// 读-改-写、绝不盲写整份。semantic 模式经反向调用 model.chat；去重向量经反向调用 embedding.embed。
// `persist:false` 时只算不写（供 memory-consolidate 纯计算摘要用）。

import { dedupNewItems } from './dedup.ts'
import type { DedupOptions } from './dedup.ts'
import {
  asString,
  errorValue,
  isRecord,
  isoAt,
  nowOf,
  uniqueStrings,
} from './plan.ts'
import { semanticSummary } from './semantic.ts'
import {
  deriveSentences,
  emptySummary,
  mergeSummaryLists,
  parseSummary,
  summaryFromSource,
  summaryToJson,
  summaryToL2Json,
  truncateSummary,
} from './summary.ts'
import type { DedupFn, Summary } from './summary.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import type { EmbeddingBackend, ModelBackend, ShortMemoryBackend } from './port-link.ts'

/** L1 TTL：24h（`expires_at = at + 24h`）。 */
export const TTL_MS = 24 * 60 * 60 * 1000

const DEFAULT_TARGET_LENGTH = 280
const DEFAULT_DEDUP_THRESHOLD = 0.9
const DEFAULT_EXTRACT_ITEMS = 3
const DEFAULT_EMBEDDING_MODEL = 'granite-97m'
const MODES = new Set(['algorithmic', 'semantic'])

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface CompressDeps {
  model?: ModelBackend
  embedding?: EmbeddingBackend
  shortMemory: ShortMemoryBackend
}

interface Context {
  args: Rec
  memory: Rec
  conversation: string | null
  workspace: string | null
  coveredUpto: string | null
  mode: 'algorithmic' | 'semantic'
  targetLength: number
  dedupThreshold: number
  extractItems: number
  embeddingModel: string
  at: string
  expiresAt: string
  persist: boolean
}

interface Requirements {
  conversation: boolean
  workspace: boolean
}

function integerField(value: Json | undefined, field: string, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new BadArgsError(`${field} must be an integer`)
  if (value < min) throw new BadArgsError(`${field} must be >= ${min}`)
  return value
}

function numberField(value: Json | undefined, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadArgsError(`${field} must be a number`)
  if (value < min || value > max) throw new BadArgsError(`${field} must be within [${min}, ${max}]`)
  return value
}

/** 解析 args 为上下文（memory 由调用方先读 owner 服务后传入）；形态非法抛 `BadArgsError`。 */
function parseContext(args: Json, env: CallEnv, memory: Rec, requirements: Requirements): Context {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const rawMode = args['mode']
  if (rawMode !== undefined && rawMode !== null && (typeof rawMode !== 'string' || !MODES.has(rawMode))) {
    throw new BadArgsError('mode must be algorithmic or semantic')
  }
  const mode = typeof rawMode === 'string' ? (rawMode as 'algorithmic' | 'semantic') : 'algorithmic'
  const conversation = asString(args['conversation'])
  const workspace = asString(args['workspace'])
  if (requirements.conversation && conversation === null) throw new BadArgsError('conversation required')
  if (requirements.workspace && workspace === null) throw new BadArgsError('workspace required')
  const rawModel = args['embedding_model']
  if (rawModel !== undefined && rawModel !== null && (typeof rawModel !== 'string' || rawModel.length === 0)) {
    throw new BadArgsError('embedding_model must be a non-empty string')
  }
  const now = nowOf(env, args)
  return {
    args,
    memory,
    conversation,
    workspace,
    coveredUpto: asString(args['covered_upto']),
    mode,
    targetLength: integerField(args['target_length'], 'target_length', DEFAULT_TARGET_LENGTH, 1),
    dedupThreshold: numberField(args['dedup_threshold'], 'dedup_threshold', DEFAULT_DEDUP_THRESHOLD, 0, 1),
    extractItems: Math.min(3, Math.max(2, integerField(args['extract_items'], 'extract_items', DEFAULT_EXTRACT_ITEMS, 1))),
    embeddingModel: typeof rawModel === 'string' ? rawModel : DEFAULT_EMBEDDING_MODEL,
    at: isoAt(now),
    expiresAt: isoAt(now + TTL_MS),
    persist: args['persist'] !== false,
  }
}

function makeDedup(deps: CompressDeps, ctx: Context): DedupFn {
  const options: DedupOptions = {
    embedding: deps.embedding,
    model: ctx.embeddingModel,
    threshold: ctx.dedupThreshold,
  }
  return (incoming: string[], reference: string[]) => dedupNewItems(incoming, reference, options)
}

function sessionsOf(memory: Rec): Rec {
  return isRecord(memory['sessions']) ? (memory['sessions'] as Rec) : {}
}

function workspacesOf(memory: Rec): Rec {
  return isRecord(memory['workspaces']) ? (memory['workspaces'] as Rec) : {}
}

function recordAt(container: Rec, key: string): Rec {
  const value = container[key]
  return isRecord(value) ? value : {}
}

function stringArray(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** 合并两段去重路径：任一段实际走了向量即报 `vector`，全部回落文本才报 `text`。 */
export function combineDedup(left: 'vector' | 'text', right: 'vector' | 'text'): 'vector' | 'text' {
  return left === 'vector' || right === 'vector' ? 'vector' : 'text'
}

/** 当前 L1 摘要（semantic prompt 的既有上下文；缺省空摘要，同样受目标长度约束）。 */
function currentL1Summary(memory: Rec, conversation: string | null, targetLength: number): Summary {
  if (conversation === null) return emptySummary()
  return truncateSummary(parseSummary(recordAt(sessionsOf(memory), conversation)['summary']), targetLength)
}

/** 写回 L1：合并摘要 + 前进 `covered_upto` + 刷新 `at` / `expires_at`。返回新 L1 记录。 */
async function updateL1(
  memory: Rec,
  conversation: string,
  incoming: Summary,
  ctx: Context,
  dedup: DedupFn,
): Promise<{ record: Rec; summary: Summary; dedup: 'vector' | 'text'; coveredUpto: Json }> {
  const existingL1 = recordAt(sessionsOf(memory), conversation)
  const existing = truncateSummary(parseSummary(existingL1['summary']), ctx.targetLength)
  const merged = await mergeSummaryLists(existing, incoming, dedup)
  const coveredUpto = ctx.coveredUpto ?? (existingL1['covered_upto'] ?? null)
  const record: Rec = {
    ...existingL1,
    summary: summaryToJson(merged.summary),
    covered_upto: coveredUpto,
    at: ctx.at,
    expires_at: ctx.expiresAt,
  }
  return { record, summary: merged.summary, dedup: merged.dedup, coveredUpto }
}

/** 抽取候选池：压缩产物的 facts / decisions，不足 2 条时由切片按句补足。 */
function collectCandidates(source: Summary, ctx: Context): string[] {
  const pool = uniqueStrings([...source.facts, ...source.decisions])
  if (pool.length < 2) pool.push(...deriveSentences(ctx.args['session_slice'], ctx.extractItems, ctx.targetLength))
  return uniqueStrings(pool)
}

interface ExtractOutcome {
  items: string[]
  dedup: 'vector' | 'text'
  insufficient: boolean
}

/** 从压缩产物抽 2–3 条不重复项（与现有 L2 facts 去重）。 */
async function extractItemsFromSource(
  source: Summary,
  memory: Rec,
  workspace: string,
  ctx: Context,
  dedup: DedupFn,
): Promise<ExtractOutcome> {
  const pool = collectCandidates(source, ctx)
  if (pool.length < 2) return { items: [], dedup: 'text', insufficient: true }
  const existingL2 = recordAt(workspacesOf(memory), workspace)
  const existingFacts = truncateSummary(parseSummary(existingL2['summary']), ctx.targetLength).facts
  const result = await dedup(pool, existingFacts)
  return { items: result.accepted.slice(0, ctx.extractItems), dedup: result.dedup, insufficient: false }
}

/** 写回 L2：抽取项并入 facts，追加来源会话，刷新 `at`。返回新 L2 记录。 */
function updateL2(memory: Rec, workspace: string, source: Summary, items: string[], ctx: Context): Rec {
  const existingL2 = recordAt(workspacesOf(memory), workspace)
  const existingSummary = truncateSummary(parseSummary(existingL2['summary']), ctx.targetLength)
  const merged: Summary = {
    ...existingSummary,
    goal: existingSummary.goal.length > 0 ? existingSummary.goal : source.goal,
    facts: [...existingSummary.facts, ...items],
  }
  const sources = uniqueStrings([...stringArray(existingL2['sources']), ctx.conversation ?? ''])
  return { ...existingL2, summary: summaryToL2Json(merged), sources, at: ctx.at }
}

/** 摘要来源：algorithmic 由结构化字段 / 切片派生；semantic 反向调模型（失败作数据）。 */
async function resolveSummary(
  ctx: Context,
  deps: CompressDeps,
): Promise<{ summary: Summary } | { error: { code: string; message: string } }> {
  if (ctx.mode === 'algorithmic') {
    return { summary: summaryFromSource(ctx.args, ctx.targetLength, ctx.extractItems) }
  }
  if (deps.model === undefined) {
    return { error: { code: 'model_unavailable', message: 'no model backend wired' } }
  }
  const semantic = await semanticSummary(ctx.args, currentL1Summary(ctx.memory, ctx.conversation, ctx.targetLength), deps.model)
  if ('error' in semantic) return semantic
  return { summary: truncateSummary(semantic.summary, ctx.targetLength) }
}

async function summarize(args: Json, env: CallEnv, deps: CompressDeps): Promise<Json> {
  const memory = await deps.shortMemory.read()
  const ctx = parseContext(args, env, memory, { conversation: true, workspace: false })
  const resolved = await resolveSummary(ctx, deps)
  if ('error' in resolved) return errorValue(resolved.error.code, resolved.error.message)
  const l1 = await updateL1(memory, ctx.conversation as string, resolved.summary, ctx, makeDedup(deps, ctx))
  if (ctx.persist) {
    await deps.shortMemory.apply({ set_sessions: { [ctx.conversation as string]: l1.record } })
  }
  return {
    ok: true,
    kind: 'summarize',
    conversation: ctx.conversation,
    covered_upto: l1.coveredUpto,
    expires_at: ctx.expiresAt,
    summary: summaryToJson(l1.summary),
    dedup: l1.dedup,
  }
}

async function compact(args: Json, env: CallEnv, deps: CompressDeps): Promise<Json> {
  const memory = await deps.shortMemory.read()
  const ctx = parseContext(args, env, memory, { conversation: true, workspace: true })
  const resolved = await resolveSummary(ctx, deps)
  if ('error' in resolved) return errorValue(resolved.error.code, resolved.error.message)
  const dedup = makeDedup(deps, ctx)
  const l1 = await updateL1(memory, ctx.conversation as string, resolved.summary, ctx, dedup)
  const extracted = await extractItemsFromSource(resolved.summary, memory, ctx.workspace as string, ctx, dedup)
  let l2: Rec | null = null
  if (!extracted.insufficient) l2 = updateL2(memory, ctx.workspace as string, resolved.summary, extracted.items, ctx)
  if (ctx.persist) {
    const applyArgs: Rec = { set_sessions: { [ctx.conversation as string]: l1.record } }
    if (l2 !== null) applyArgs['set_workspaces'] = { [ctx.workspace as string]: l2 }
    await deps.shortMemory.apply(applyArgs)
  }
  const payload: Rec = {
    ok: true,
    kind: 'compact',
    conversation: ctx.conversation,
    workspace: ctx.workspace,
    covered_upto: l1.coveredUpto,
    expires_at: ctx.expiresAt,
    summary: summaryToJson(l1.summary),
    items: extracted.items,
    dedup: combineDedup(l1.dedup, extracted.dedup),
  }
  if (extracted.insufficient) payload['extract_skipped'] = 'insufficient_content'
  return payload
}

async function extract(args: Json, env: CallEnv, deps: CompressDeps): Promise<Json> {
  const memory = await deps.shortMemory.read()
  const ctx = parseContext(args, env, memory, { conversation: false, workspace: true })
  const source = summaryFromSource(ctx.args, ctx.targetLength, ctx.extractItems)
  const dedup = makeDedup(deps, ctx)
  const extracted = await extractItemsFromSource(source, memory, ctx.workspace as string, ctx, dedup)
  if (extracted.insufficient) {
    return errorValue('insufficient_content', 'not enough distinct items to extract 2-3')
  }
  if (extracted.items.length === 0) {
    return {
      ok: true,
      kind: 'extract',
      workspace: ctx.workspace,
      items: [],
      dedup: extracted.dedup,
      reason: 'all_duplicate',
    }
  }
  const l2 = updateL2(memory, ctx.workspace as string, source, extracted.items, ctx)
  if (ctx.persist) {
    await deps.shortMemory.apply({ set_workspaces: { [ctx.workspace as string]: l2 } })
  }
  return {
    ok: true,
    kind: 'extract',
    workspace: ctx.workspace,
    items: extracted.items,
    dedup: extracted.dedup,
  }
}

/** 构造方法表（依赖注入：模型 / 向量化 / 短期记忆后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: CompressDeps): Record<string, Handler> {
  return {
    summarize: (args: Json, env: CallEnv): Promise<Json> => summarize(args, env, deps),
    compact: (args: Json, env: CallEnv): Promise<Json> => compact(args, env, deps),
    extract: (args: Json, env: CallEnv): Promise<Json> => extract(args, env, deps),
  }
}
