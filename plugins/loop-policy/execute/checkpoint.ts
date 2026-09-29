// 段边界检查点：上下文压力越阈时，经 `compress.summarize` 产出结构化摘要，追加一条 `checkpoint`
// 步记录作为新的历史基础。压缩走**图外独立模型调用**——`mode:'semantic'` 经 `semantic` → `model.chat`
// 用独立连接压（不占用图内回合、不把压缩文本渲染进消息流）；无可用模型连接时回落 `algorithmic`。
// 喂给压缩器的是**整段会话切片**（往期回合 + 工具结果 + 本回合在途），不只本回合。
// 压缩失败不得让回合失败：跳过记录，回合照常续段。
// 结构化字段形状与 context-window 消费侧（views.ts / candidates.ts）一致；`facts` 映射为 `findings`。

import { isRecord, numberField } from './plan.ts'
import { appendStep, nextStepSeq } from './steplog.ts'
import { isStructuredCheckpoint } from './subagent.ts'
import type { GraphModel, Json, PortCaller, Rec, RunState } from './types.ts'

/** 触发档位：软阈段边界压缩 / 硬阈要求下一调用前已压缩 / 应急（降级阶梯用尽）。 */
export type CheckpointLevel = 'soft' | 'hard' | 'emergency'

export interface CheckpointThresholds {
  soft: number
  hard: number
  emergency: number
}

export interface CheckpointInput {
  port: PortCaller
  bag: Rec
  model: GraphModel
  rs: RunState
  turnId: string
  level: CheckpointLevel
}

export interface CheckpointResult {
  emitted: boolean
  code?: string
}

/** 本段 `context.assemble` 的清单压力；缺清单 / 预算非正 ⇒ null（不触发）。 */
export function contextPressure(rs: RunState): { used: number; budget: number; ratio: number } | null {
  const manifest = isRecord(rs.shared['context_manifest']) ? (rs.shared['context_manifest'] as Rec) : null
  if (manifest === null) return null
  const used = numberField(manifest['used'])
  const budget = numberField(manifest['budget'])
  if (used === null || budget === null || budget <= 0) return null
  return { used, budget, ratio: used / budget }
}

/** 触发阈值：`bag.checkpoint_thresholds` 覆盖 > 图阈值（loop-policy 权威）> 内建缺省。 */
export function checkpointThresholds(model: GraphModel, bag: Rec): CheckpointThresholds {
  const override = isRecord(bag['checkpoint_thresholds']) ? (bag['checkpoint_thresholds'] as Rec) : {}
  const pick = (key: string, threshold: string, fallback: number): number => {
    const fromBag = numberField(override[key])
    if (fromBag !== null) return fromBag
    return numberField(model.thresholds[threshold]) ?? fallback
  }
  return {
    soft: pick('soft', 'checkpoint_soft_ratio', 0.7),
    hard: pick('hard', 'checkpoint_hard_ratio', 0.85),
    emergency: pick('emergency', 'checkpoint_emergency_ratio', 0.95),
  }
}

/** 越阈档位：未达软阈 ⇒ null。 */
export function checkpointLevel(ratio: number, thresholds: CheckpointThresholds): CheckpointLevel | null {
  if (ratio >= thresholds.emergency) return 'emergency'
  if (ratio >= thresholds.hard) return 'hard'
  if (ratio >= thresholds.soft) return 'soft'
  return null
}

/** 字符串列表（去空、去重、保序）。 */
function stringList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 目标：优先 L1 goal（`bag.l1.goal` / `bag.memories.l1.goal`），否则留空由切片派生。 */
function goalOf(bag: Rec): string {
  const l1 = isRecord(bag['l1']) ? (bag['l1'] as Rec) : null
  if (l1 !== null && typeof l1['goal'] === 'string' && l1['goal'].length > 0) return l1['goal'] as string
  const memories = isRecord(bag['memories']) ? (bag['memories'] as Rec) : null
  const memL1 = memories !== null && isRecord(memories['l1']) ? (memories['l1'] as Rec) : null
  if (memL1 !== null && typeof memL1['goal'] === 'string' && memL1['goal'].length > 0) return memL1['goal'] as string
  return ''
}

/** 会话 id（compress 的 L1 键）：优先本会话标识，缺省回落回合 id。 */
function conversationOf(bag: Rec, turnId: string): string {
  for (const key of ['session_id', 'conversation_id', 'thread']) {
    const value = bag[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return turnId
}

/** 消息文本：字符串直取；`parts` 形态拼接 text 片。 */
function contentText(message: Rec): string {
  const content = message['content']
  if (typeof content === 'string') return content
  const parts = message['parts']
  if (!Array.isArray(parts)) return ''
  const out: string[] = []
  for (const part of parts) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') out.push(part['text'] as string)
  }
  return out.join('\n')
}

/** 工具结果项 → 文本（字符串直取；失败取 error；其余稳定 JSON 序列化）。 */
function resultText(result: Json): string {
  if (typeof result === 'string') return result
  if (!isRecord(result)) return ''
  if (result['ok'] === false && typeof result['error'] === 'string') return result['error']
  return JSON.stringify(result['result'] ?? result)
}

/**
 * 整段会话切片：往期回合（`bag.session.turns`）逐条重建——用户消息 / 助手正文 / **工具结果**全带，
 * 排除本回合（本回合由在途 `rs.extraMessages` + `bag.input` 承担，避免与步日志重复）。
 * 供压缩器读全量上下文（不只本回合），这是「喂整段上下文给图外压缩器」的输入。
 */
function contextSlice(bag: Rec, rs: RunState, turnId: string): Rec[] {
  const out: Rec[] = []
  for (const turn of turnsOf(bag)) {
    if (typeof turn['turn_id'] === 'string' && turn['turn_id'] === turnId) continue
    const userMessage = isRecord(turn['user_message']) ? (turn['user_message'] as Rec) : null
    const userText = userMessage !== null ? contentText(userMessage) : ''
    if (userText.length > 0) out.push({ role: 'user', content: userText })
    const steps = Array.isArray(turn['steps']) ? (turn['steps'] as Json[]) : []
    for (const step of steps) {
      if (!isRecord(step) || step['type'] !== 'step.result') continue
      const assistant = isRecord(step['assistant']) ? (step['assistant'] as Rec) : null
      const assistantText = assistant !== null ? contentText(assistant) : ''
      if (assistantText.length > 0) out.push({ role: 'assistant', content: assistantText })
      const results = Array.isArray(step['tool_results']) ? (step['tool_results'] as Json[]) : []
      for (const result of results) {
        const text = resultText(result)
        if (text.length > 0) out.push({ role: 'tool', content: text })
      }
    }
  }
  const input = bag['input']
  const inputText = typeof input === 'string' ? input : isRecord(input) ? contentText(input) : ''
  if (inputText.length > 0) out.push({ role: 'user', content: inputText })
  for (const message of rs.extraMessages) {
    if (!isRecord(message)) continue
    const role = typeof message['role'] === 'string' ? (message['role'] as string) : 'assistant'
    const text = contentText(message as Rec)
    if (text.length > 0) out.push({ role, content: text })
  }
  return out
}

/** 图外压缩用的模型连接：优先显式 `compress_model_config`，否则回落图内 `config`（同连接、独立调用）。 */
function compressionModelConfig(bag: Rec): Rec | null {
  const explicit = bag['compress_model_config']
  if (isRecord(explicit)) return explicit
  const config = bag['config']
  return isRecord(config) ? config : null
}

/** 本回合已触达的文件路径（来自末批工具调用 args.path）。 */
function touchedFiles(rs: RunState): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const call of rs.lastCalls) {
    const args = isRecord(call['args']) ? (call['args'] as Rec) : null
    const path = args !== null ? args['path'] : undefined
    if (typeof path !== 'string' || path.length === 0 || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * compress 摘要 → 检查点结构化形状。
 * `decisions` / `findings`（来自 facts）/ `files` 编成对象项（`{what}` / `{claim}` / `{path}`），
 * 与步记录 schema 的 items 形状一致；开放问题与后续步骤为字符串项。
 * `covered_upto` 为全局边界 `{turn_id, seq}`；`extras` 承接上一累计检查点里 compress 形状不承载的字段。
 */
function toCheckpointSummary(summary: Rec, boundary: Rec, extras: Rec): Rec {
  const out: Rec = {}
  const goal = typeof summary['goal'] === 'string' ? summary['goal'] : ''
  if (goal.length > 0) out['goal'] = goal
  const decisions = stringList(summary['decisions'])
  if (decisions.length > 0) out['decisions'] = decisions.map((what) => ({ what }))
  const findings = stringList(summary['facts'])
  if (findings.length > 0) out['findings'] = findings.map((claim) => ({ claim }))
  const openQuestions = stringList(summary['open_questions'])
  if (openQuestions.length > 0) out['open_questions'] = openQuestions
  const files = stringList(summary['files'])
  if (files.length > 0) out['files'] = files.map((path) => ({ path }))
  const nextSteps = stringList(summary['next_steps'])
  if (nextSteps.length > 0) out['next_steps'] = nextSteps
  for (const [key, value] of Object.entries(extras)) out[key] = value
  out['covered_upto'] = boundary
  return out
}

/** 检查点项（字符串或 `{what|claim|path|step|text|summary}` 对象）→ 字符串列表。 */
function itemStrings(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    let text: string | null = null
    if (typeof item === 'string') text = item
    else if (isRecord(item)) {
      for (const key of ['what', 'claim', 'path', 'step', 'text', 'summary']) {
        const candidate = item[key]
        if (typeof candidate === 'string' && candidate.length > 0) {
          text = candidate
          break
        }
      }
    }
    if (text === null || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 全部会话回合（`bag.session.turns`）。 */
function turnsOf(bag: Rec): Rec[] {
  const session = isRecord(bag['session']) ? (bag['session'] as Rec) : null
  if (session === null) return []
  const turns = Array.isArray(session['turns']) ? (session['turns'] as Json[]) : []
  return turns.filter(isRecord)
}

/**
 * 本回合日志里、当前边界之前的最新结构化检查点（累计摘要的来源）。
 * 词序按（回合序, 步号）：更早的回合整体在前，同回合只取步号更小的检查点。
 */
function priorCheckpoint(bag: Rec, turnId: string, boundarySeq: number): Rec | null {
  const turns = turnsOf(bag)
  const currentIndex = turns.findIndex((turn) => turn['turn_id'] === turnId)
  let found: Rec | null = null
  turns.forEach((turn, index) => {
    if (currentIndex >= 0 && index > currentIndex) return
    const steps = Array.isArray(turn['steps']) ? (turn['steps'] as Json[]) : []
    for (const step of steps) {
      if (!isRecord(step) || step['type'] !== 'checkpoint') continue
      if (!isStructuredCheckpoint(step['summary'])) continue
      if (index === currentIndex) {
        const seq = numberField(step['seq'])
        if (seq === null || seq >= boundarySeq) continue
      }
      found = step['summary'] as Rec
    }
  })
  return found
}

/** 检查点结构化摘要 → compress 摘要形状（goal / decisions / facts / files / …）。 */
function toCompressSummary(summary: Rec): Rec {
  const out: Rec = {}
  const goal = typeof summary['goal'] === 'string' ? summary['goal'] : ''
  if (goal.length > 0) out['goal'] = goal
  const decisions = itemStrings(summary['decisions'])
  if (decisions.length > 0) out['decisions'] = decisions
  const findings = itemStrings(summary['findings'])
  if (findings.length > 0) out['facts'] = findings
  const files = itemStrings(summary['files'])
  if (files.length > 0) out['files'] = files
  const openQuestions = itemStrings(summary['open_questions'])
  if (openQuestions.length > 0) out['open_questions'] = openQuestions
  const nextSteps = itemStrings(summary['next_steps'])
  if (nextSteps.length > 0) out['next_steps'] = nextSteps
  return out
}

/** 上一累计检查点里 compress 形状不承载、需原样承接的字段。 */
function extrasOf(summary: Rec | null): Rec {
  const out: Rec = {}
  if (summary === null) return out
  for (const key of ['constraints', 'errors_to_avoid', 'user_preferences']) {
    if (summary[key] !== undefined) out[key] = summary[key] as Json
  }
  return out
}

/**
 * 写一条段边界检查点：调用 `compress.summarize`（有独立模型连接则 `semantic`、否则 `algorithmic`；
 * 均 `persist:false`）后追加步记录。输入为整段会话切片（含工具结果）。
 * 任一步失败（传输 / 下游错误 / 空摘要 / 追加失败）都只回 `{emitted:false}`，不抛、不阻断回合。
 */
export async function emitCheckpoint(input: CheckpointInput): Promise<CheckpointResult> {
  const { port, bag, rs, turnId } = input
  const coveredUpto = rs.steps
  // 全局覆盖边界：本回合 + 当前步号。旧式数字只在本回合内有意义，累积检查点改用全局边界。
  const boundary: Rec = { turn_id: turnId, seq: coveredUpto }
  const prior = priorCheckpoint(bag, turnId, coveredUpto)
  // 幂等：上一检查点已覆盖到当前位置（本回合且步号不落后）⇒ 无新增内容，不重复压。
  const priorBoundary = prior !== null && isRecord(prior['covered_upto']) ? (prior['covered_upto'] as Rec) : null
  if (priorBoundary !== null && priorBoundary['turn_id'] === turnId) {
    const priorSeq = numberField(priorBoundary['seq'])
    if (priorSeq !== null && priorSeq >= coveredUpto) return { emitted: false, code: 'already_covered' }
  }
  const modelConfig = compressionModelConfig(bag)
  const args: Rec = {
    conversation: conversationOf(bag, turnId),
    goal: goalOf(bag),
    files: touchedFiles(rs),
    session_slice: contextSlice(bag, rs, turnId),
    mode: modelConfig !== null ? 'semantic' : 'algorithmic',
    persist: false,
  }
  // semantic 模式所需的模型连接实例（图外独立调用；占位回退算法模式）。
  if (modelConfig !== null) args['model_config'] = modelConfig
  // 累计：把上一累计检查点作为 prior_summary 先并入，产出 = 上一累计 + 本回合切片。
  if (prior !== null) args['prior_summary'] = toCompressSummary(prior)
  const workspace = bag['workspace_id']
  if (typeof workspace === 'string' && workspace.length > 0) args['workspace'] = workspace

  let value: Json = null
  try {
    const outcome = await port.call('compress', 'summarize', args)
    if (!outcome.ok) return { emitted: false, code: outcome.code }
    value = outcome.value
  } catch {
    return { emitted: false, code: 'transport_failed' }
  }
  if (!isRecord(value) || value['ok'] !== true) {
    const error = isRecord(value) && isRecord(value['error']) ? (value['error'] as Rec) : {}
    return { emitted: false, code: typeof error['code'] === 'string' ? (error['code'] as string) : 'compress_failed' }
  }
  const result = isRecord(value['summary']) ? (value['summary'] as Rec) : null
  if (result === null) return { emitted: false, code: 'compress_empty' }
  const summary = toCheckpointSummary(result, boundary, extrasOf(prior))
  // 无任何结构性内容时不落记录：避免「记为检查点但无内容」使旧回合被静默覆盖。
  if (!Object.keys(summary).some((key) => key !== 'covered_upto')) return { emitted: false, code: 'compress_empty' }
  // 序号先行占据（单调、唯一），与其它步 / 段标记不撞键，且与 sink 位置无关。
  const seq = nextStepSeq(rs)
  const appended = await appendStep(port, {
    type: 'checkpoint',
    turn_id: turnId,
    seq,
    summary,
    covered_upto: boundary,
    // 触发档位（soft / hard / emergency）：观测用，消费侧按 `summary` 读取，忽略本字段。
    rung: input.level,
  })
  if (!appended.ok) return { emitted: false, code: 'owner_unavailable' }
  return { emitted: true }
}
