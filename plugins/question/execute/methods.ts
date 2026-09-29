// 能力类 `question` 的方法：describe / invoke / list / sweep。
// 队列与 resume 游标写自有持久存储（④），返回的 `$directives` 只含续跑 eval 与 extern（观测）。
// 服务不读投影、无写链通道、不自取时钟。
//
// `invoke` 两路：
//   ① 工具 `question`（args.tool === 'question'）——入队：item 写自有存储 + 发 question.pending，本 run 正常结束；
//   ② 命令 `question.answer` 入口（args 为空）——经反向调用 `input.read` 取本线程作答槽，按 id 在自有存储定位 item，
//      写回 answers 并清槽，产续跑计划 [eval(chat.resume), extern]。

import { resolveConfig } from './config.ts'
import {
  asArray,
  asString,
  buildResume,
  evalCommandDirective,
  externDirective,
  externOnly,
  isRecord,
  isoAt,
  nowOf,
  type Rec,
} from './plan.ts'
import { questionId, type QuestionStore } from './store.ts'
import { describeValue, normalizeQuestions, renderCard } from './tools.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, ServiceEvent } from 'plugin-sdk'

const CONFIG = resolveConfig()

/** 服务依赖：自有存储 + `input` 反向调用通道（读 / 清作答槽）。 */
export interface QuestionDeps {
  store: QuestionStore
  input: PortCaller
}

/** 幂等键：同回合同一提问节点的重复入队收敛到同一条。取游标里的稳定小字段，不落整份游标。 */
function opKeyOf(run: string, cursor: Json | undefined): string {
  if (typeof cursor === 'string') return `${run}:question:${cursor}`
  if (isRecord(cursor)) {
    const callId = asString(cursor['call_id'])
    if (callId !== null) return `${run}:question:${callId}`
    const nodeIndex = cursor['node_index']
    if (typeof nodeIndex === 'number') return `${run}:question:${nodeIndex}`
  }
  return `${run}:question`
}

/**
 * 会话 id：`session_id` 直给优先；否则从 `session` 取——字符串即 id，
 * 切片 `{body:{current}}`（调用方读会话后传入）取 `current` / `id`。
 */
function sessionIdOf(bag: Rec): string | null {
  const direct = asString(bag['session_id'])
  if (direct !== null) return direct
  const session = bag['session']
  const asText = asString(session)
  if (asText !== null) return asText
  if (isRecord(session)) {
    const body = isRecord(session['body']) ? (session['body'] as Rec) : session
    return asString(body['current']) ?? asString(body['id'])
  }
  return null
}

// ── describe ───────────────────────────────────────────────────────────────

function describe(): HandlerResult {
  return { value: describeValue(CONFIG), events: [] }
}

// ── invoke ①：工具 question（入队） ─────────────────────────────────────────

function enqueue(params: Rec, bag: Rec, env: CallEnv, store: QuestionStore): HandlerResult {
  const normalized = normalizeQuestions(params['questions'], CONFIG)
  if (!normalized.ok) {
    return {
      value: { ok: false, error: { code: normalized.code, message: normalized.message } },
      events: [],
    }
  }
  const run = asString(bag['run']) ?? env.run ?? 'run'
  const thread = asString(bag['thread']) ?? env.thread ?? '_main'
  const opKey = opKeyOf(run, bag['cursor'])
  const existing = store.findByOpKey(opKey)
  if (existing !== null) {
    return {
      value: {
        ok: true,
        result: {
          ok: true,
          status: 'pending',
          id: existing['id'],
          count: store.count(),
          render: renderCard(existing),
        },
      },
      events: [],
    }
  }

  const session = sessionIdOf(bag)
  const frameNow = nowOf(env)
  const atText = asString(bag['at'])
  const atMs = atText === null ? frameNow : Date.parse(atText)
  const at = atText ?? isoAt(frameNow)
  const baseMs = Number.isFinite(atMs) ? atMs : frameNow
  const expiresAt = CONFIG.expiresMs === null ? null : isoAt(baseMs + CONFIG.expiresMs)
  const id = questionId(run, store.count())
  const item: Rec = {
    id,
    op_key: opKey,
    run,
    session,
    thread,
    questions: normalized.questions,
    answers: null,
    expired: false,
    resume: buildResume(bag, thread),
    at,
    expires_at: expiresAt,
  }
  store.turnOpen(run)
  store.appendItem(run, item)
  store.turnClose(run)
  const events: ServiceEvent[] = [
    {
      topic: 'question.pending',
      payload: { run: env.run ?? run, thread, id, count: store.count() },
    },
  ]
  const value = {
    ok: true,
    result: { ok: true, status: 'pending', id, count: store.count(), render: renderCard(item) },
  }
  return { value, events }
}

// ── invoke ②：命令 question.answer（作答续跑） ──────────────────────────────

/** 失败收口：结构化 extern，不产业务写（槽由本服务在收口路径清理）。 */
function answerFailure(code: string, message: string): HandlerResult {
  return { value: externOnly({ ok: false, error: { code, message } }), events: [] }
}

/**
 * 作答形态校验：数组；每项对象、`question_id` 非空字符串、`selected` 字符串数组（可缺省）、
 * `custom` 字符串（可缺省）。空数组合法（用户可「全部忽略」）。
 */
function validAnswers(value: Json[]): boolean {
  for (const item of value) {
    if (!isRecord(item)) return false
    if (asString(item['question_id']) === null) return false
    const selected = item['selected']
    if (selected !== undefined && selected !== null) {
      if (!Array.isArray(selected) || selected.some((piece) => typeof piece !== 'string'))
        return false
    }
    const custom = item['custom']
    if (custom !== undefined && custom !== null && typeof custom !== 'string') return false
  }
  return true
}

async function answerCommand(env: CallEnv, deps: QuestionDeps): Promise<HandlerResult> {
  const thread = asString(env.thread) ?? '_main'
  const read = await deps.input.call('input', 'read', { thread })
  if (!read.ok) return answerFailure(read.code, read.message)
  const slot = isRecord(read.value) ? read.value['slot'] : null
  if (!isRecord(slot) || slot['kind'] !== 'question.answer') {
    return answerFailure('no_slot', 'no question.answer slot')
  }
  const id = asString(slot['id'])
  const answers = asArray(slot['answers'])
  if (id === null) return answerFailure('missing_id', 'slot.id required')
  if (answers === null) return answerFailure('missing_answers', 'slot.answers required')

  /** 收口即清槽：作答槽只消费一次，失败也清，避免残留遮挡后续作答。 */
  const failAndClear = async (code: string, message: string): Promise<HandlerResult> => {
    await deps.input.call('input', 'clear', { thread_id: thread })
    return answerFailure(code, message)
  }

  const item = deps.store.get(id)
  if (item === null) return failAndClear('not_found', id)
  if (!validAnswers(answers)) return failAndClear('bad_answers', 'slot.answers malformed')
  // 已答 / 过期不再续跑：重放旧槽或双端竞态不得重开同一回合。
  if (item['answers'] !== null) return failAndClear('already_answered', id)
  if (item['expired'] === true) return failAndClear('expired', id)

  const resume = isRecord(item['resume']) ? (item['resume'] as Rec) : null
  const resumeArgs = resume !== null && isRecord(resume['args']) ? (resume['args'] as Rec) : null
  const cursor = resumeArgs === null ? null : (resumeArgs['cursor'] ?? null)
  if (resume === null || resumeArgs === null || cursor === null) {
    return failAndClear('no_resume_cursor', id)
  }

  const itemThread = asString(item['thread']) ?? thread
  const run = env.run
  const updated: Rec = { ...item, answers }
  deps.store.turnOpen(run)
  deps.store.updateItem(run, updated)
  deps.store.turnClose(run)
  // 作答槽已被消费：清本线程槽（失败不阻断续跑，槽残留由写入端覆盖）。
  await deps.input.call('input', 'clear', { thread_id: thread })

  const at = asString(item['at'])
  // 作答结果随附交互卡描述符（与入队同一 renderCard 口径，含 `id` / `questions` / `answers`）：
  // 续跑段的落盘 part 才会保留题干与 `detail.id`——否则只回落目录静态壳（空卡），
  // UI 既无法按 `id` 调 `question.state` 对账，也认不出已答。
  const render = renderCard(updated)
  const directives: Json[] = [
    // 续跑不再自带整份投影：`inject` 声明由宿主执行期把投影切片并入 args。
    evalCommandDirective(
      'chat.resume',
      { cursor, thread: itemThread, payload: { answers, render } },
      { ids: ['ids'] },
    ),
    externDirective({ ok: true, status: 'answered', id, thread: itemThread, at, render }),
  ]
  return { value: { $directives: directives }, events: [] }
}

/** `question.invoke`：按有无 `tool` 分流工具调用 / 作答命令入口。 */
async function invoke(args: Json, env: CallEnv, deps: QuestionDeps): Promise<HandlerResult> {
  const bag = isRecord(args) ? args : {}
  const tool = asString(bag['tool'])
  if (tool === null) return answerCommand(env, deps)
  if (tool !== 'question') {
    return {
      value: { ok: false, error: { code: 'unknown_tool', message: tool } },
      events: [],
    }
  }
  const params = isRecord(bag['args']) ? (bag['args'] as Rec) : {}
  return enqueue(params, bag, env, deps.store)
}

// ── list（只读） ───────────────────────────────────────────────────────────

function list(store: QuestionStore): HandlerResult {
  const items = store.itemsInOrder()
  const answered = items.filter((item) => item['answers'] !== null).length
  const expired = items.filter((item) => item['expired'] === true).length
  return {
    value: externOnly({
      ok: true,
      version: 1,
      count: store.count(),
      answered,
      expired,
      items,
    }),
    events: [],
  }
}

// ── state（只读对账：供 UI 重拉后判定已答 / 过期） ─────────────────────────

/**
 * 只回判定所需的窄字段：`{id, answered, answers, expired}`；**不含 `questions` / `resume`**（
 * resume 内是不透明 loop 游标，不得经入站面外泄）。`answered` 与 `answers:null` 双写，
 * 使「全部忽略」提交的空数组也能被识别为已答。
 */
function state(store: QuestionStore): HandlerResult {
  const items = store.itemsInOrder().map((item) => ({
    id: item['id'] ?? null,
    answered: item['answers'] !== null,
    answers: item['answers'] ?? null,
    expired: item['expired'] === true,
  }))
  return { value: externOnly({ ok: true, version: 1, items }), events: [] }
}

// ── sweep（宿主周期方法） ───────────────────────────────────────────────────

function isExpired(item: Rec, now: number): boolean {
  if (item['answers'] !== null) return false
  if (item['expired'] === true) return false
  const expiresAt = asString(item['expires_at'])
  if (expiresAt === null) return false
  const atMs = Date.parse(expiresAt)
  return Number.isFinite(atMs) && atMs <= now
}

function sweep(env: CallEnv, store: QuestionStore): HandlerResult {
  const now = nowOf(env)
  const targets = store.itemsInOrder().filter((item) => isExpired(item, now))
  if (targets.length === 0) {
    return { value: externOnly({ ok: true, changed: false, expired: 0 }), events: [] }
  }
  const run = env.run
  store.turnOpen(run)
  store.updateItems(
    run,
    targets.map((item) => ({ ...item, expired: true })),
  )
  store.turnClose(run)
  return { value: externOnly({ ok: true, changed: true, expired: targets.length }), events: [] }
}

// ── 方法表 ─────────────────────────────────────────────────────────────────

export function createHandlers(deps: QuestionDeps): Record<string, Handler> {
  return {
    describe: () => describe(),
    invoke: (args, env) => invoke(args, env, deps),
    list: () => list(deps.store),
    state: () => state(deps.store),
    sweep: (args, env) => {
      void args
      return sweep(env, deps.store)
    },
  }
}
