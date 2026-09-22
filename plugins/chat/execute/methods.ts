// 能力类 `chat` 的方法表：send（回合启动）/ history（展示历史窗口）/ resume（跨 run 续跑）。
// 管道已换代：#14 不再自持 context.build → model.chat → session.commit 静态段序，改为
// `port.call loop-policy.interpret`（一次 bag 覆盖全部节点；#33 自驱解释器再按节点分发）。
// 本服务只负责 bag 装配（bag 装配契约）、首条消息 title 旁路段与计划机械合并。
// 入口 term 只传投影切片；服务不读投影、不写链、不自取时钟（now 一律取 env）。

import {
  buildInterpretBag,
  buildTitleArgs,
  bodyOf,
  findConversation,
  firstMessageOf,
  modelConfigOf,
  refsOf,
  shouldGenerateTitle,
  slotOf,
  threadKey,
} from './assemble.ts'
import { buildHistory, parseHistoryQuery } from './history.ts'
import { asString, errorValue, externOnly, isErrorValue, isRecord, mergeDirectives } from './plan.ts'
import { BadArgsError } from './types.ts'
import type { Wiring } from './wiring.ts'
import type { CallEnv, Handler, Json, PortCaller, Rec } from './types.ts'

/** 服务依赖：反向调用通道 + 生效接线（单测可注入假端口）。 */
export interface ChatDeps {
  port: PortCaller
  wiring: Wiring
}

/** 槽 kind：只有 `chat.message` 跑管道。 */
const CHAT_MESSAGE = 'chat.message'

/** #33 图解释器入口（编排唯一的 eff）。 */
const LOOP_PORT = 'loop-policy'
const INTERPRET_METHOD = 'interpret'

/** #49 首条消息标题旁路段。 */
const TITLE_PORT = 'session-title'
const TITLE_METHOD = 'generate'

interface TurnContext {
  ids: Json
  thread: string
  slot: Json
  conversation: Rec | null
  conversationId: string | null
  config: Rec
  sessionBody: Rec
}

/** 反向调用结果：成功带计划值，失败带已收口的 extern 值。 */
type InterpretOutcome = { ok: true; value: Json } | { ok: false; failure: Json }

/** 从投影切片解析本回合上下文（会话 / 槽 / 连接实例）。 */
function turnContext(ids: Json, env: CallEnv): TurnContext {
  const thread = threadKey(env.thread)
  const sessionBody = bodyOf(ids, 'session') ?? {}
  const conversationId = asString(sessionBody['current'])
  return {
    ids,
    thread,
    slot: slotOf(ids, thread) ?? {},
    conversation: conversationId === null ? null : findConversation(sessionBody, conversationId),
    conversationId,
    config: modelConfigOf(ids) ?? {},
    sessionBody,
  }
}

/** 连接实例可用性：vendor / model / base_url 齐备才允许派发。 */
function configUsable(config: Rec): boolean {
  return asString(config['base_url']) !== null && asString(config['model']) !== null
}

/** 调 `loop-policy.interpret`；传输失败 / 结构化失败统一以 extern 收口。 */
async function callInterpret(deps: ChatDeps, bag: Rec): Promise<InterpretOutcome> {
  const outcome = await deps.port.call(LOOP_PORT, INTERPRET_METHOD, bag)
  if (!outcome.ok) return { ok: false, failure: externOnly(errorValue('loop_unavailable', outcome.message)) }
  if (isErrorValue(outcome.value)) return { ok: false, failure: externOnly(outcome.value) }
  return { ok: true, value: outcome.value }
}

/**
 * 回合启动：读本线程槽 kind → 空槽 / 非 chat kind 幂等 no-op；
 * 否则装配 interpret bag 派发 #33，再把首条消息的 title 旁路段按段序合并。
 */
async function send(args: Json, env: CallEnv, deps: ChatDeps): Promise<Json> {
  const ids = args
  if (!isRecord(ids)) throw new BadArgsError('ids must be an object')
  const wiring = deps.wiring
  const thread = threadKey(env.thread)
  const slot = slotOf(ids, thread)
  if (!isRecord(slot) || slot['kind'] !== CHAT_MESSAGE) {
    return wiring.on_empty_slot === 'error'
      ? externOnly(errorValue('empty_slot', `no ${CHAT_MESSAGE} in thread ${thread}`))
      : externOnly({ ok: true, noop: true })
  }

  const turn = turnContext(ids, env)
  if (!configUsable(turn.config)) {
    return externOnly(errorValue('model_not_configured', 'config vendor/model/base_url missing'))
  }
  const bag = buildInterpretBag({
    ids: turn.ids,
    wiring,
    slot: turn.slot,
    conversation: turn.conversation,
    conversationId: turn.conversationId,
    config: turn.config,
    thread: turn.thread,
  })
  const interpreted = await callInterpret(deps, bag)
  if (!interpreted.ok) return interpreted.failure

  const segments: Json[] = [interpreted.value]
  const titleDefault = wiring.title.title_default
  if (wiring.title.when === 'first_message' && shouldGenerateTitle(turn.conversation, titleDefault)) {
    const titleArgs = buildTitleArgs({
      conversationId: turn.conversationId as string,
      firstMessage: firstMessageOf(turn.slot),
      config: turn.config,
      sessionBody: turn.sessionBody,
      titleDefault,
    })
    const titleOutcome = await deps.port.call(TITLE_PORT, TITLE_METHOD, titleArgs)
    // 旁路段 on_fail=ignore：传输失败 / 无计划一律跳过，不影响主回合。
    if (titleOutcome.ok) segments.push(titleOutcome.value)
  }
  const merged = mergeDirectives(segments)
  if ((merged['$directives'] as Json[]).length === 0) {
    return externOnly(errorValue('no_plan', 'loop-policy.interpret returned no plan'))
  }
  return merged
}

/** 展示历史：从投影 `session` 沿 `prev` 还原链，按 `{conversation, before, limit}` 切窗。 */
function history(args: Json, env: CallEnv): Json {
  const ids = isRecord(args) && isRecord(args['ids']) ? args['ids'] : args
  if (!isRecord(ids)) throw new BadArgsError('ids must be an object')
  const sessionBody = bodyOf(ids, 'session') ?? {}
  const refs = refsOf(ids, 'session')
  const query = parseHistoryQuery(args)
  const conversation = query.conversation ?? asString(env.thread) ?? asString(sessionBody['current'])
  return buildHistory(sessionBody, refs, {
    conversation,
    before: query.before,
    limit: query.limit,
  })
}

/**
 * 跨 run 续跑（H18）：args `{cursor, thread, payload?, ids?}`。
 * `ids` = 调用方（#39 审批 / #48 提问服务）随 plan eval args 传入的投影切片
 * （内核 term 不能同时传 args 与投影，这是既定变通，见 reveal / search 先例）。
 * 装配与 send 相同的 interpret bag，另加 `bag.resume={cursor,thread,payload}` 交 #33 恢复执行。
 */
async function resume(args: Json, env: CallEnv, deps: ChatDeps): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('resume args must be an object')
  const cursor = args['cursor']
  if (!isRecord(cursor)) throw new BadArgsError('cursor must be an object')
  const ids = isRecord(args['ids']) ? args['ids'] : {}
  const thread = threadKey(asString(args['thread']) ?? env.thread)
  const payload = isRecord(args['payload']) ? args['payload'] : null

  const sessionBody = bodyOf(ids, 'session') ?? {}
  const conversationId = asString(sessionBody['current'])
  const conversation = conversationId === null ? null : findConversation(sessionBody, conversationId)
  const config = modelConfigOf(ids) ?? {}
  if (!configUsable(config)) {
    return externOnly(errorValue('model_not_configured', 'config vendor/model/base_url missing'))
  }
  const bag = buildInterpretBag({
    ids,
    wiring: deps.wiring,
    slot: slotOf(ids, thread) ?? {},
    conversation,
    conversationId,
    config,
    thread,
  })
  const resumeBag: Rec = { cursor, thread }
  if (payload !== null) resumeBag['payload'] = payload
  bag['resume'] = resumeBag

  const interpreted = await callInterpret(deps, bag)
  if (!interpreted.ok) return interpreted.failure
  const merged = mergeDirectives([interpreted.value])
  if ((merged['$directives'] as Json[]).length === 0) {
    return externOnly(errorValue('no_plan', 'loop-policy.interpret returned no plan'))
  }
  return merged
}

/** 构造方法表（依赖注入：反向调用通道与接线由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: ChatDeps): Record<string, Handler> {
  return {
    send: (args: Json, env: CallEnv): Promise<Json> => send(args, env, deps),
    history: (args: Json, env: CallEnv): Json => history(args, env),
    resume: (args: Json, env: CallEnv): Promise<Json> => resume(args, env, deps),
  }
}
