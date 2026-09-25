// 能力类 `chat` 的方法表：send（回合启动）/ history（展示历史窗口）/ resume（跨 run 续跑）。
// 管道已换代：#14 不再自持 context.build → model.chat → session.commit 静态段序，改为
// `port.call loop-policy.interpret`（一次 bag 覆盖全部节点；#33 自驱解释器再按节点分发）。
// 本服务只负责 bag 装配（bag 装配契约）、首条消息 title 旁路段与计划机械合并。
// 入口 term 只传投影切片；服务不读投影、不写链、不自取时钟（now 一律取 env）。

import {
  buildInterpretBag,
  buildTitleArgs,
  bodyOf,
  conversationsOf,
  findConversation,
  firstMessageOf,
  modelConfigOf,
  shouldGenerateTitle,
  slotOf,
  threadKey,
  withConversationTitle,
  workspaceKnown,
} from './assemble.ts'
import { asString, errorValue, externOnly, isErrorValue, isRecord, mergeDirectives } from './plan.ts'
import { createRefHydrator } from './refs.ts'
import type { DefReader, RefHydrator } from './refs.ts'
import { BadArgsError } from './types.ts'
import type { Wiring } from './wiring.ts'
import type { CallEnv, Handler, Json, PortCaller, Rec } from './types.ts'

/** 服务依赖：反向调用通道 + 生效接线（单测可注入假端口）；`host` 为只读解析通道（缺省只吃已解析 refs）。 */
export interface ChatDeps {
  port: PortCaller
  wiring: Wiring
  host?: PortCaller
}

/** 投影里 refs 会被本服务消费的身份（其余身份只读 body，无需解析引用）。 */
const REF_IDENTITIES = [
  'session',
  'loop-policy',
  'evolution',
  'approval',
  'question',
  'todo',
  'agents',
] as const

/** 把投影切片里各身份的 refs（哈希列表）按需解析成闭包；已是对象则原样。 */
async function hydrateIds(
  ids: Json,
  hydrator: RefHydrator,
  identities: readonly string[] = REF_IDENTITIES,
): Promise<Json> {
  if (!isRecord(ids)) return ids
  const out: Rec = { ...ids }
  for (const identity of identities) {
    const entry = out[identity]
    if (!isRecord(entry)) continue
    out[identity] = { ...entry, refs: await hydrator.hydrate(identity, entry['refs']) }
  }
  return out
}

/** 槽 kind：只有 `chat.message` 跑管道。 */
const CHAT_MESSAGE = 'chat.message'

/** 运行记录 owner 身份（消息链 / 输入槽 / 短期记忆 / 待办已出世界，改经 `eff` 问 owner）。 */
const SESSION_PORT = 'session'
const SESSION_READ = 'read'
const INPUT_PORT = 'input'
const INPUT_READ = 'read'
const SHORT_MEMORY_PORT = 'short-memory'
const SHORT_MEMORY_READ = 'read'
const TODO_PORT = 'todo'
const TODO_INVOKE = 'invoke'

/**
 * 从 owner 服务取会话切片、输入槽、短期记忆与当前会话待办，覆盖投影里的同名身份条目。
 * 消息链 / 输入槽 / L1-L2 / 待办已出世界（不产 `write` directive），服务读自有持久存储后返回。
 * 取不到时回落空切片（缺省身份由下游回落种子 / 内建兜底），不阻塞主回合。
 */
async function withOwnerSlices(deps: ChatDeps, ids: Json, env: CallEnv, thread: string): Promise<Json> {
  const base: Rec = isRecord(ids) ? { ...ids } : {}
  const sessionOutcome = await deps.port.call(SESSION_PORT, SESSION_READ, {})
  const session = sessionOutcome.ok && isRecord(sessionOutcome.value) ? sessionOutcome.value : { version: 1, current: null, conversations: [] }
  const inputOutcome = await deps.port.call(INPUT_PORT, INPUT_READ, { thread })
  const input = inputOutcome.ok && isRecord(inputOutcome.value) ? inputOutcome.value : { slots: {} }
  base[SESSION_PORT] = { body: session, refs: isRecord(session['refs']) ? session['refs'] : {}, data_gen: null }
  base[INPUT_PORT] = { body: input }

  const memoryOutcome = await deps.port.call(SHORT_MEMORY_PORT, SHORT_MEMORY_READ, {})
  const memory = memoryOutcome.ok && isRecord(memoryOutcome.value) ? memoryOutcome.value : { version: 1, sessions: {}, workspaces: {} }
  base[SHORT_MEMORY_PORT] = { body: memory }

  const conversationId = asString(session['current'])
  const todoOutcome =
    conversationId === null
      ? null
      : await deps.port.call(TODO_PORT, TODO_INVOKE, { tool: 'todo.read', session_id: conversationId })
  const todoResult =
    todoOutcome !== null && todoOutcome.ok && isRecord(todoOutcome.value) && todoOutcome.value['ok'] === true && isRecord(todoOutcome.value['result'])
      ? (todoOutcome.value['result'] as Rec)
      : { items: [] }
  base[TODO_PORT] = { body: todoResult }
  return base
}

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
async function send(
  args: Json,
  env: CallEnv,
  deps: ChatDeps,
  hydrator: RefHydrator,
): Promise<Json> {
  const projected = await hydrateIds(args, hydrator)
  if (!isRecord(projected)) throw new BadArgsError('ids must be an object')
  const wiring = deps.wiring
  const thread = threadKey(env.thread)
  const ids = await withOwnerSlices(deps, projected, env, thread)
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

  // 无当前会话：按槽内 `workspace_id` / `conversation_id` 装配一个 main 会话，
  // 由 `session.commit` 随消息同世代原子建（发送即开新会话；标题也在此回合生成）。
  let newConversation: Rec | null = null
  if (turn.conversationId === null) {
    const slotRec = isRecord(turn.slot) ? turn.slot : {}
    const workspaceId = asString(slotRec['workspace_id'])
    if (workspaceId === null || !workspaceKnown(turn.ids, workspaceId)) {
      return externOnly(errorValue('workspace_missing', 'workspace_id required to start a conversation'))
    }
    const conversationId =
      asString(slotRec['conversation_id']) ??
      `c-${env.now}-${conversationsOf(turn.sessionBody).length}`
    turn.conversationId = conversationId
    turn.conversation = {
      id: conversationId,
      workspace_id: workspaceId,
      kind: 'main',
      title: wiring.title.title_default,
      count: 0,
      head: null,
    }
    newConversation = { id: conversationId, workspace_id: workspaceId }
  }

  // 首条消息：**先算标题并并入 session body**，由 `session.commit` 随消息一次性落盘。
  // 不再把 `session.set_title` 的整份写计划合并进来——否则它会以回合起始旧基覆盖提交的 head/count。
  let sessionBody = turn.sessionBody
  const titleDefault = wiring.title.title_default
  if (
    wiring.title.when === 'first_message' &&
    turn.conversationId !== null &&
    shouldGenerateTitle(turn.conversation, titleDefault)
  ) {
    const titleArgs = buildTitleArgs({
      conversationId: turn.conversationId,
      firstMessage: firstMessageOf(turn.slot),
      config: turn.config,
      sessionBody: turn.sessionBody,
      titleDefault,
    })
    const titleOutcome = await deps.port.call(TITLE_PORT, TITLE_METHOD, titleArgs)
    // 旁路段 on_fail=ignore：传输失败 / 无标题值一律跳过，不影响主回合。
    const title =
      titleOutcome.ok && isRecord(titleOutcome.value) ? asString(titleOutcome.value['title']) : null
    if (title !== null) {
      // 新建会话：标题随 `new_conversation` 交 commit 建会话时落；
      // 既有会话：标题**写 owner 服务**（session.set_title 写自有存储），并并入本次 interpret 的 body 供本回合视图。
      if (newConversation !== null) newConversation['title'] = title
      else {
        sessionBody = withConversationTitle(sessionBody, turn.conversationId, title)
        await deps.port.call(SESSION_PORT, 'set_title', { conversation: turn.conversationId, title })
      }
    }
  }

  const bag = buildInterpretBag({
    ids: turn.ids,
    wiring,
    slot: turn.slot,
    conversation: turn.conversation,
    conversationId: turn.conversationId,
    config: turn.config,
    thread: turn.thread,
    sessionBody,
  })
  if (newConversation !== null) bag['new_conversation'] = newConversation
  const interpreted = await callInterpret(deps, bag)
  if (!interpreted.ok) return interpreted.failure

  const merged = mergeDirectives([interpreted.value])
  if ((merged['$directives'] as Json[]).length === 0) {
    return externOnly(errorValue('no_plan', 'loop-policy.interpret returned no plan'))
  }
  return merged
}

/** 展示历史：问 `session` 服务取自有存储还原的窗口（不再读投影 refs / 逐跳 hydrator）。 */
async function history(args: Json, env: CallEnv, deps: ChatDeps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const outcome = await deps.port.call(SESSION_PORT, 'history', {
    conversation: asString(record['conversation']),
    before: asString(record['before']),
    limit: typeof record['limit'] === 'number' ? record['limit'] : null,
  })
  if (!outcome.ok) return errorValue('session_unavailable', outcome.message)
  if (isErrorValue(outcome.value)) return outcome.value
  return outcome.value
}

/**
 * 跨 run 续跑（H18）：args `{cursor, thread, payload?, ids?}`。
 * `ids` = 调用方（#39 审批 / #48 提问服务）随 plan eval args 传入的投影切片
 * （内核 term 不能同时传 args 与投影，这是既定变通，见 reveal / search 先例）。
 * 装配与 send 相同的 interpret bag，另加 `bag.resume={cursor,thread,payload}` 交 #33 恢复执行。
 */
async function resume(
  args: Json,
  env: CallEnv,
  deps: ChatDeps,
  hydrator: RefHydrator,
): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('resume args must be an object')
  const cursor = args['cursor']
  if (!isRecord(cursor)) throw new BadArgsError('cursor must be an object')
  const projected = isRecord(args['ids']) ? await hydrateIds(args['ids'], hydrator) : {}
  const thread = threadKey(asString(args['thread']) ?? env.thread)
  const ids = await withOwnerSlices(deps, projected, env, thread)
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
  const read: DefReader = async (identity, hashes) => {
    if (deps.host === undefined) return null
    const outcome = await deps.host.call('host', 'def.read', { identity, hashes })
    if (!outcome.ok) return null
    return isRecord(outcome.value) ? outcome.value : null
  }
  const hydrator = createRefHydrator(read)
  return {
    send: (args: Json, env: CallEnv): Promise<Json> => send(args, env, deps, hydrator),
    history: (args: Json, env: CallEnv): Promise<Json> => history(args, env, deps),
    resume: (args: Json, env: CallEnv): Promise<Json> => resume(args, env, deps, hydrator),
  }
}
