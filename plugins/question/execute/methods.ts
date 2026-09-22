// 能力类 `question` 的方法：describe / invoke / list / sweep。
// 只构造写计划 + 事件，不读投影、不落账、不自取时钟：队列 body / item 引用闭包 / 输入槽整份 slots
// 由调用方入口 term 读出随 args 传入，周期 sweep 的投影片段由宿主按 schema.periodic.reads 注入 bag。
//
// `invoke` 两路：
//   ① 工具 `question`（bag.tool === 'question'）——入队：item 进世界 + 发 question.pending，本 run 正常结束；
//   ② 命令 `question.answer` 入口（bag 无 tool、为投影 ids）——按槽 id 沿 tail 链定位 item，产续跑计划
//      [eval(chat.resume) , write(记答案 + 清槽)]（H18）。续跑 args 自带投影切片 `ids`（内核 term 不能同时
//      传 args 与投影，故调用方携带供 #14 服务装配 interpret bag；先例见 #16 `reveal` / #17 `search`）。
//      两路都不读 #1 投影，数据随 args 传入。

import { resolveConfig } from './config.ts'
import {
  addGenOp,
  asArray,
  asCount,
  asString,
  buildResume,
  clearSlotsBody,
  countOf,
  evalCommandDirective,
  externDirective,
  externOnly,
  isRecord,
  isoAt,
  itemsFromChain,
  locateItem,
  nowOf,
  planOf,
  prevOf,
  putOp,
  queueOf,
  refOf,
  refsOf,
} from './plan.ts'
import { describeValue, normalizeQuestions, renderCard } from './tools.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, ServiceEvent } from './types.ts'
import type { Rec } from './plan.ts'

const CONFIG = resolveConfig()

function requireRecord(value: Json | undefined, field: string): Rec {
  if (!isRecord(value)) throw new BadArgsError(`${field} must be an object`)
  return value
}

/** 投影里的队列条目：`{body, refs}`；缺省回落空队列 / 空引用。 */
function queueView(projection: Json | undefined): { queue: Rec; refs: Rec } {
  if (!isRecord(projection)) return { queue: queueOf({}), refs: {} }
  const body = projection['body']
  const refs = projection['refs']
  return {
    queue: isRecord(body) ? body : queueOf({}),
    refs: isRecord(refs) ? refs : {},
  }
}

/**
 * 会话 id：`session_id` 直给优先；否则从 `session` 取——字符串即 id，
 * 投影切片 `{body:{current}}`（入口 term 读 `ids.session.body.current` 后传入）取 `current` / `id`。
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

/** 兼容三种入参形态：`{question:{body,refs}}` / 周期 bag `{queue,refs}` / 投影 `{body,refs}`。 */
function readQueueArgs(args: Rec): { queue: Rec; refs: Rec } {
  const question = args['question']
  if (isRecord(question)) return queueView(question)
  if (isRecord(args['queue']) || isRecord(args['refs'])) {
    return { queue: queueOf(args), refs: refsOf(args) }
  }
  return queueView(args)
}

/** 找 `question.answer` 槽：按线程键升序取首个（正常只有一个）。 */
function findAnswerSlot(inputBody: Json | undefined): { threadKey: string; slot: Rec } | null {
  if (!isRecord(inputBody)) return null
  const slots = inputBody['slots']
  if (!isRecord(slots)) return null
  for (const threadKey of Object.keys(slots).sort()) {
    const slot = slots[threadKey]
    if (isRecord(slot) && slot['kind'] === 'question.answer') return { threadKey, slot }
  }
  return null
}

// ── describe ───────────────────────────────────────────────────────────────

function describe(): HandlerResult {
  return { value: describeValue(CONFIG), events: [] }
}

// ── invoke ①：工具 question（入队） ─────────────────────────────────────────

function enqueue(params: Rec, bag: Rec, env: CallEnv): HandlerResult {
  const normalized = normalizeQuestions(params['questions'], CONFIG)
  if (!normalized.ok) {
    return {
      value: { ok: false, error: { code: normalized.code, message: normalized.message } },
      events: [],
    }
  }
  const { queue } = readQueueArgs(bag)
  const count = countOf(queue)
  const run = asString(bag['run']) ?? env.run ?? 'run'
  const thread = asString(bag['thread']) ?? env.thread ?? '_main'
  const session = sessionIdOf(bag)
  const at = asString(bag['at']) ?? isoAt(nowOf(env))
  const expiresAt = CONFIG.expiresMs === null ? null : isoAt(nowOf(env) + CONFIG.expiresMs)
  const id = `q-${run}-${count}`
  const item: Rec = {
    id,
    run,
    session,
    thread,
    questions: normalized.questions,
    answers: null,
    expired: false,
    resume: buildResume(bag, thread),
    at,
    expires_at: expiresAt,
    prev: prevOf(queue),
  }
  const ops = [
    putOp(item),
    putOp({ ...queue, version: 1, tail: { def: { $n: 0 } }, count: count + 1 }),
    addGenOp('question', 1),
  ]
  const events: ServiceEvent[] = [
    {
      topic: 'question.pending',
      payload: { run: env.run ?? run, thread, id, count: count + 1 },
    },
  ]
  const value = planOf(ops, {
    ok: true,
    status: 'pending',
    id,
    count: count + 1,
    render: renderCard(item),
  })
  // 工具契约（同 plugin-admin / todo）：成功回 {ok:true, result: <写计划值>}，写计划冒泡交 #27/#33。
  return { value: { ok: true, result: value }, events }
}

// ── invoke ②：命令 question.answer（作答续跑） ──────────────────────────────

/** 失败收口：清本线程槽（若给了 slots）+ 结构化 extern，不产业务写。 */
function rejectWithClear(slotsBody: Rec | null, threadKey: string, code: string, message: string): HandlerResult {
  const payload: Rec = { ok: false, error: { code, message } }
  if (slotsBody === null) return { value: externOnly(payload), events: [] }
  const ops = [putOp(clearSlotsBody(slotsBody, threadKey)), addGenOp('input', 0)]
  return { value: planOf(ops, payload), events: [] }
}

function answerCommand(ids: Rec): HandlerResult {
  const inputProjection = ids['input']
  const inputBody = isRecord(inputProjection) && isRecord(inputProjection['body'])
    ? (inputProjection['body'] as Rec)
    : null
  const found = findAnswerSlot(inputBody)
  if (found === null) {
    return {
      value: externOnly({ ok: false, error: { code: 'no_slot', message: 'no question.answer slot' } }),
      events: [],
    }
  }
  const id = asString(found.slot['id'])
  const answers = asArray(found.slot['answers'])
  if (id === null) return rejectWithClear(inputBody, found.threadKey, 'missing_id', 'slot.id required')
  if (answers === null) {
    return rejectWithClear(inputBody, found.threadKey, 'missing_answers', 'slot.answers required')
  }

  const { queue, refs } = queueView(ids['question'])
  const located = locateItem(queue, refs, id)
  if (located === null) {
    return rejectWithClear(inputBody, found.threadKey, 'not_found', id)
  }

  const item = located.item
  const thread = asString(item['thread']) ?? found.threadKey
  const resume = isRecord(item['resume']) ? (item['resume'] as Rec) : null
  const resumeArgs = resume !== null && isRecord(resume['args']) ? (resume['args'] as Rec) : null
  const cursor = resumeArgs === null ? null : (resumeArgs['cursor'] ?? null)
  const at = asString(item['at'])

  const updated: Rec = { ...item, answers, prev: refOf(located.hash) }
  const ops = [
    putOp(updated),
    putOp({ ...queue, version: 1, tail: { def: { $n: 0 } }, count: countOf(queue) }),
    addGenOp('question', 1),
    putOp(clearSlotsBody(inputBody as Rec, found.threadKey)),
    addGenOp('input', 3),
  ]
  const directives: Json[] = [
    evalCommandDirective('chat.resume', { cursor, thread, payload: { answers }, ids }),
    { kind: 'write', request: { op: 'batch', args: { ops } } },
    externDirective({ ok: true, status: 'answered', id, thread, at }),
  ]
  return { value: { $directives: directives }, events: [] }
}

/** `question.invoke`：按有无 `tool` 分流工具调用 / 作答命令入口。 */
function invoke(args: Rec, env: CallEnv): HandlerResult {
  const tool = asString(args['tool'])
  if (tool === null) return answerCommand(args)
  if (tool !== 'question') {
    return {
      value: { ok: false, error: { code: 'unknown_tool', message: tool } },
      events: [],
    }
  }
  const params = isRecord(args['args']) ? (args['args'] as Rec) : {}
  return enqueue(params, args, env)
}

// ── list（只读） ───────────────────────────────────────────────────────────

function list(args: Rec): HandlerResult {
  const { queue, refs } = readQueueArgs(args)
  const items = itemsFromChain(queue, refs)
  const answered = items.filter((item) => item['answers'] !== null).length
  const expired = items.filter((item) => item['expired'] === true).length
  return {
    value: externOnly({
      ok: true,
      version: asCount(queue['version']) ?? 1,
      count: countOf(queue),
      answered,
      expired,
      items: [...items].reverse(),
    }),
    events: [],
  }
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

/** 过期项标 `expired`：链式追加同 id 新版本 def（旧 def 仍在链上），只动 tail，不改 count。 */
function sweep(args: Rec, env: CallEnv): HandlerResult {
  const { queue, refs } = readQueueArgs(args)
  const items = itemsFromChain(queue, refs)
  const now = nowOf(env)
  const targets = [...items].reverse().filter((item) => isExpired(item, now))
  if (targets.length === 0) {
    return { value: externOnly({ ok: true, changed: false, expired: 0 }), events: [] }
  }
  const ops: Json[] = []
  let prev: Json = prevOf(queue)
  for (const item of targets) {
    const index = ops.length
    ops.push(putOp({ ...item, expired: true, prev }))
    prev = { def: { $n: index } }
  }
  const bodyIndex = ops.length
  ops.push(putOp({ ...queue, version: 1, tail: prev, count: countOf(queue) }))
  ops.push(addGenOp('question', bodyIndex))
  return { value: planOf(ops, { ok: true, changed: true, expired: targets.length }), events: [] }
}

// ── 方法表 ─────────────────────────────────────────────────────────────────

export const HANDLERS: Record<string, Handler> = {
  describe: () => describe(),
  invoke: (args, env) => invoke(requireRecord(args, 'args'), env),
  list: (args) => list(requireRecord(args, 'args')),
  sweep: (args, env) => sweep(requireRecord(args, 'args'), env),
}
