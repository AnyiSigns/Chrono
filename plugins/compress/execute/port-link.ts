// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// 本插件 `needs` 含 `summarize` → summarize、`semantic` → semantic、`dedup` → dedup：
// 摘要形状 / 派生 / 合并经 `port.call summarize.*`；semantic 模式经 `port.call semantic.summarize`；
// 去重经 `port.call dedup.dedup`；L1 / L2 读写经 `port.call short-memory.*`。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from './plan.ts'
import { BackendError } from './types.ts'
import type { DedupOutcome, Json, Rec, Summary } from './types.ts'
import type { PortCaller } from 'plugin-sdk'

/** `summarize.*` 反向调用的等待上限；须严格小于本服务 `compress.summarize`（本地纯函数，快）。 */
export const SUMMARIZE_TIMEOUT_MS = 30000
/** `semantic.summarize` 反向调用的等待上限；须大于 `semantic.summarize` 声明、小于 `compress.summarize`。 */
export const SEMANTIC_TIMEOUT_MS = 3800000
/** `dedup.dedup` 反向调用的等待上限；须大于 `dedup.dedup` 声明。 */
export const DEDUP_TIMEOUT_MS = 45000

/** 摘要形状（与 `summarize` 提供方同口径；跨身份不 import，消费方保留本地类型）。 */
function stringList(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** 把 `summarize` 回包归一成本地摘要形状（缺字段回落空）。 */
function asSummary(value: Json | undefined): Summary {
  const record = isRecord(value) ? value : {}
  return {
    goal: typeof record['goal'] === 'string' ? record['goal'] : '',
    decisions: stringList(record['decisions']),
    facts: stringList(record['facts']),
    open_questions: stringList(record['open_questions']),
    files: stringList(record['files']),
    next_steps: stringList(record['next_steps']),
  }
}

/** 结构化摘要后端抽象：生产环境是反向调用 `summarize.*`，单测注入假后端。 */
export interface SummarizeBackend {
  derive(args: Json, targetLength: number, extractItems: number): Promise<Summary>
  parse(record: Json | undefined): Promise<Summary>
  current(record: Json | undefined, targetLength: number): Promise<Summary>
  sentences(sessionSlice: Json | undefined, limit: number, targetLength: number): Promise<string[]>
  merge(
    existing: Summary,
    incoming: Summary,
    outcomes: Rec,
  ): Promise<{ summary: Summary; dedup: 'vector' | 'text' }>
  toL1(summary: Summary): Promise<Rec>
  toL2(summary: Summary): Promise<Rec>
}

/** `summarize.*` 的反向调用后端：成功回摘要形状，失败抛结构化 BackendError。 */
export class RemoteSummarize implements SummarizeBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  private async call(method: string, args: Rec): Promise<Rec> {
    const outcome = await this.link.call('summarize', method, args, {
      timeoutMs: SUMMARIZE_TIMEOUT_MS,
    })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('summarize_bad_result', `summarize.${method} returned a non-object`)
    return outcome.value
  }

  async derive(args: Json, targetLength: number, extractItems: number): Promise<Summary> {
    const value = await this.call('derive', {
      args,
      target_length: targetLength,
      extract_items: extractItems,
    })
    return asSummary(value['summary'])
  }

  async parse(record: Json | undefined): Promise<Summary> {
    const value = await this.call('parse', { record: record ?? null })
    return asSummary(value['summary'])
  }

  async current(record: Json | undefined, targetLength: number): Promise<Summary> {
    const value = await this.call('current', {
      record: record ?? null,
      target_length: targetLength,
    })
    return asSummary(value['summary'])
  }

  async sentences(
    sessionSlice: Json | undefined,
    limit: number,
    targetLength: number,
  ): Promise<string[]> {
    const value = await this.call('sentences', {
      session_slice: sessionSlice ?? null,
      limit,
      target_length: targetLength,
    })
    return stringList(value['sentences'])
  }

  async merge(
    existing: Summary,
    incoming: Summary,
    outcomes: Rec,
  ): Promise<{ summary: Summary; dedup: 'vector' | 'text' }> {
    const value = await this.call('merge', { existing, incoming, outcomes })
    return {
      summary: asSummary(value['summary']),
      dedup: value['dedup'] === 'vector' ? 'vector' : 'text',
    }
  }

  async toL1(summary: Summary): Promise<Rec> {
    const value = await this.call('to_l1', { summary })
    return isRecord(value['record']) ? value['record'] : {}
  }

  async toL2(summary: Summary): Promise<Rec> {
    const value = await this.call('to_l2', { summary })
    return isRecord(value['record']) ? value['record'] : {}
  }
}

/** 语义摘要后端抽象：生产环境是反向调用 `semantic.summarize`，单测注入假后端。 */
export interface SemanticBackend {
  /** 回 `{summary}` 或 `{error:{code,message}}`（失败作数据）。 */
  summarize(args: Rec, existingL1: Json): Promise<Rec>
}

/** `semantic.summarize` 的反向调用后端：成功回回包，失败抛结构化 BackendError。 */
export class RemoteSemantic implements SemanticBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async summarize(args: Rec, existingL1: Json): Promise<Rec> {
    const outcome = await this.link.call(
      'semantic',
      'summarize',
      { args, existing_l1: existingL1 ?? {} },
      { timeoutMs: SEMANTIC_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('semantic_bad_result', 'semantic.summarize returned a non-object')
    return outcome.value
  }
}

/** 去重后端抽象：生产环境是反向调用 `dedup.dedup`，单测注入假后端。 */
export interface DedupBackend {
  dedup(
    incoming: string[],
    reference: string[],
    model: string,
    threshold: number,
  ): Promise<DedupOutcome>
}

/** `dedup.dedup` 的反向调用后端：成功回去重结果，失败抛结构化 BackendError。 */
export class RemoteDedup implements DedupBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async dedup(
    incoming: string[],
    reference: string[],
    model: string,
    threshold: number,
  ): Promise<DedupOutcome> {
    const outcome = await this.link.call(
      'dedup',
      'dedup',
      { incoming, reference, model, threshold },
      { timeoutMs: DEDUP_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value) || !Array.isArray(outcome.value['accepted'])) {
      throw new BackendError('dedup_bad_result', 'dedup.dedup returned no accepted list')
    }
    const accepted = outcome.value['accepted'].filter(
      (item): item is string => typeof item === 'string',
    )
    return { accepted, dedup: outcome.value['dedup'] === 'vector' ? 'vector' : 'text' }
  }
}

/** 短期记忆 owner 后端抽象：生产环境是反向调用 `short-memory.read` / `apply`，单测注入假后端。 */
export interface ShortMemoryBackend {
  read(): Promise<Rec>
  apply(args: Rec): Promise<Rec>
}

/** `short-memory` 的反向调用后端：读整份 L1 / L2，逐键置 / 删写回。 */
export class RemoteShortMemory implements ShortMemoryBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async read(): Promise<Rec> {
    const outcome = await this.link.call('short-memory', 'read', {})
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('short_memory_bad_result', 'short-memory.read returned a non-object')
    return outcome.value
  }

  async apply(args: Rec): Promise<Rec> {
    const outcome = await this.link.call('short-memory', 'apply', args)
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('short_memory_bad_result', 'short-memory.apply returned a non-object')
    return outcome.value
  }
}
