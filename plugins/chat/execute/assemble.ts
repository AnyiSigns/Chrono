// interpret bag / title args 装配（纯函数）：入口 term 只传投影切片，服务按 bag 装配契约装配。
// 下游消费者：#33 `loop-policy.interpret`（一次 bag 覆盖全部节点；#33 再按节点分发）、
// #49 `session-title.generate`（首条消息标题段 args）。装配只做读取与机械拼装，不做写。
// 服务不读投影：世界数据由入口 term 读出随 args / ids 传入。

import { asString, defHashOf, isRecord, numberField } from './plan.ts'
import { sliceEnabled } from './wiring.ts'
import type { Wiring } from './wiring.ts'
import type { Json, Rec } from './types.ts'

/** 缺省线程键（per-thread 键控：无 env.thread 时回落）。 */
export const MAIN_THREAD = '_main'

/** 投影里的身份条目（无该身份 / 形态非法回 null）。 */
export function entryOf(ids: Json, identity: string): Rec | null {
  if (!isRecord(ids)) return null
  const entry = ids[identity]
  return isRecord(entry) ? entry : null
}

/** 投影里的身份 body（无数据世代 / 形态非法回 null）。 */
export function bodyOf(ids: Json, identity: string): Rec | null {
  const entry = entryOf(ids, identity)
  if (entry === null || !isRecord(entry['body'])) return null
  return entry['body']
}

/** 投影里的身份 refs（缺省空对象）。 */
export function refsOf(ids: Json, identity: string): Rec {
  const entry = entryOf(ids, identity)
  if (entry === null || !isRecord(entry['refs'])) return {}
  return entry['refs']
}

/** 线程键：`env.thread` 非空字符串，否则 `_main`（H16）。 */
export function threadKey(thread: string | null): string {
  return asString(thread) ?? MAIN_THREAD
}

/** 本线程槽体：`ids.input.body.slots[thread]`。 */
export function slotOf(ids: Json, thread: string): Json | undefined {
  const input = bodyOf(ids, 'input')
  if (input === null || !isRecord(input['slots'])) return undefined
  return (input['slots'] as Rec)[thread]
}

/** 会话列表（数组）；缺失 / 非数组返回空数组。 */
export function conversationsOf(session: Rec): Json[] {
  const list = session['conversations']
  return Array.isArray(list) ? list : []
}

/** 按 id 取会话条目。 */
export function findConversation(session: Rec, id: string): Rec | null {
  for (const item of conversationsOf(session)) {
    if (isRecord(item) && item['id'] === id) return item
  }
  return null
}

/** 会话条目的链头哈希（`head.def`）；无头 / 形态非法返回 null。 */
export function headHashOf(conversation: Rec | null): string | null {
  if (conversation === null || !isRecord(conversation['head'])) return null
  const hash = (conversation['head'] as Rec)['def']
  return typeof hash === 'string' ? hash : null
}

function limitOf(meta: Rec | null): Rec | null {
  if (meta === null || !isRecord(meta['limit'])) return null
  return meta['limit'] as Rec
}

/**
 * 模型连接实例：从 `#2 config` 的当前 vendor / model 解析 provider 与档案，
 * 拼出 `{vendor, model, base_url, auth_ref, params, quirks?, protocol?, context_window?, max_output?}`。
 * `#12`（连接）与 `#13`（预算）共用同源 config；缺 vendor / model / provider 回 null。
 */
export function modelConfigOf(ids: Json): Rec | null {
  const configBody = bodyOf(ids, 'config')
  if (configBody === null) return null
  const vendor = asString(configBody['vendor'])
  const model = asString(configBody['model'])
  if (vendor === null || model === null) return null
  const providers = isRecord(configBody['providers']) ? configBody['providers'] : {}
  const provider = isRecord(providers[vendor]) ? (providers[vendor] as Rec) : null
  if (provider === null) return null
  const models = isRecord(provider['models']) ? provider['models'] : {}
  const meta = isRecord(models[model]) ? (models[model] as Rec) : null
  const limit = limitOf(meta)

  const config: Rec = { vendor, model }
  const baseUrl = asString(provider['base_url'])
  if (baseUrl !== null) config['base_url'] = baseUrl
  if (isRecord(provider['auth_ref'])) config['auth_ref'] = provider['auth_ref']
  config['params'] = isRecord(configBody['params']) ? configBody['params'] : {}
  const quirks = isRecord(provider['quirks'])
    ? provider['quirks']
    : meta !== null && isRecord(meta['quirks'])
      ? meta['quirks']
      : null
  if (quirks !== null) config['quirks'] = quirks
  const protocol = asString(provider['protocol']) ?? (meta !== null ? asString(meta['protocol']) : null)
  if (protocol !== null) config['protocol'] = protocol
  const contextWindow =
    (meta !== null ? numberField(meta['context_window']) : null) ??
    (limit !== null ? numberField(limit['context']) : null)
  const maxOutput =
    (meta !== null ? numberField(meta['max_output']) : null) ??
    (limit !== null ? numberField(limit['output']) : null)
  if (contextWindow !== null) config['context_window'] = contextWindow
  if (maxOutput !== null) config['max_output'] = maxOutput
  return config
}

/** 当前权限档：`#2 config.permission`（#25 / #26 / #27 共用）。 */
export function tierOf(ids: Json): string | null {
  const configBody = bodyOf(ids, 'config')
  return configBody === null ? null : asString(configBody['permission'])
}

/** 从 `#2 config.ui.style` 取风格文本（缺省 null）。 */
function styleOf(ids: Json): Json {
  const configBody = bodyOf(ids, 'config')
  if (configBody === null || !isRecord(configBody['ui'])) return null
  const style = (configBody['ui'] as Rec)['style']
  return asString(style) !== null ? style : null
}

/** 从 `#36 skill` body 取技能候选（缺省 null）。 */
function skillsOf(ids: Json): Json {
  const skillBody = bodyOf(ids, 'skill')
  if (skillBody === null || !Array.isArray(skillBody['skills'])) return null
  return skillBody['skills']
}

/** 记忆片段：本会话 L1 + 工作区 L2（按 slices 开关）。 */
function memoriesOf(ids: Json, conversation: Rec | null, wiring: Wiring): Rec {
  const memoryBody = bodyOf(ids, 'short-memory')
  const out: Rec = {}
  if (memoryBody === null) return out
  const conversationId = conversation !== null ? asString(conversation['id']) : null
  if (sliceEnabled(wiring, 'l1') && conversationId !== null && isRecord(memoryBody['sessions'])) {
    const entry = (memoryBody['sessions'] as Rec)[conversationId]
    if (isRecord(entry)) out['l1'] = entry
  }
  if (sliceEnabled(wiring, 'l2')) {
    const workspaceId = conversation !== null ? asString(conversation['workspace_id']) : null
    if (workspaceId !== null && isRecord(memoryBody['workspaces'])) {
      const entry = (memoryBody['workspaces'] as Rec)[workspaceId]
      if (isRecord(entry)) out['l2'] = entry
    }
  }
  return out
}

/**
 * `#11` 会话切片：body 字段 + 当前会话链头 + 全量 refs（供 #13 沿 prev 还原）
 * + `data_gen`（写方据此把下一世代写成补丁世代；无数据世代为 null）。
 */
function sessionSlice(sessionBody: Rec, conversation: Rec | null, refs: Rec, dataGen: Json): Rec {
  return { ...sessionBody, head: headHashOf(conversation), refs, data_gen: dataGen }
}

/** 会话 body 的某会话条目改标题（浅拷贝，不动入参）；用于把生成的标题并入本次提交。 */
export function withConversationTitle(sessionBody: Rec, conversationId: string, title: string): Rec {
  const list = Array.isArray(sessionBody['conversations']) ? (sessionBody['conversations'] as Json[]) : []
  const conversations = list.map((item) =>
    isRecord(item) && item['id'] === conversationId ? { ...item, title } : item,
  )
  return { ...sessionBody, conversations }
}

/** 本轮用户消息：槽体规范化成 #13 能解析的 `{content, parts?, attachments?}`。 */
function inputOf(slot: Json): Rec {
  const slotRec = isRecord(slot) ? slot : {}
  const text = asString(slotRec['text']) ?? asString(slotRec['content']) ?? ''
  const input: Rec = { content: text }
  if (Array.isArray(slotRec['parts'])) input['parts'] = slotRec['parts']
  if (Array.isArray(slotRec['attachments'])) input['attachments'] = slotRec['attachments']
  return input
}

/** 沿 `prev` 从 tail 回溯链式条目（newest→oldest）；坏引用 / 成环即停。 */
export function chainEntries(container: Json | undefined, refs: Rec): Rec[] {
  if (!isRecord(container)) return []
  const out: Rec[] = []
  const seen = new Set<string>()
  let hash = defHashOf(container['tail'])
  while (hash !== null && !seen.has(hash)) {
    seen.add(hash)
    const body = refs[hash]
    if (!isRecord(body)) break
    out.push(body)
    hash = defHashOf(body['prev'])
  }
  return out
}

/** `#33` 图数据切片：六类条目 body + refs 闭包（#33 按 `refs` 解析链式条目与图单值）。 */
export function graphSliceOf(ids: Json): Rec | null {
  const body = bodyOf(ids, 'loop-policy')
  if (body === null) return null
  return { ...body, refs: refsOf(ids, 'loop-policy') }
}

/** `#43 evolution` 台账切片：四类链 body + refs 闭包 + data_gen（写方据此写补丁世代）。 */
export function ledgerSliceOf(ids: Json): Rec | null {
  const body = bodyOf(ids, 'evolution')
  if (body === null) return null
  const entry = entryOf(ids, 'evolution')
  return { ...body, refs: refsOf(ids, 'evolution'), data_gen: entry !== null && entry['data_gen'] !== undefined ? entry['data_gen'] : null }
}

/** 执行根：当前会话 `workspace_id` → `#41 workspace` body 的 path。 */
export function workspaceOf(ids: Json, conversation: Rec | null): { id: string | null; root: string | null } {
  const workspaceId = conversation !== null ? asString(conversation['workspace_id']) : null
  const body = bodyOf(ids, 'workspace')
  const list = body !== null && Array.isArray(body['workspaces']) ? body['workspaces'] : []
  for (const item of list) {
    if (!isRecord(item)) continue
    if (workspaceId !== null && item['id'] === workspaceId) {
      return { id: workspaceId, root: asString(item['path']) }
    }
  }
  return { id: workspaceId, root: null }
}

/** `#47 todo` 门禁切片：当前会话条目沿链还原为 `{items:[…]}`（供 #33 `todo_incomplete`）。 */
export function todoSliceOf(ids: Json, conversationId: string | null): Rec | null {
  if (conversationId === null) return null
  const body = bodyOf(ids, 'todo')
  if (body === null || !isRecord(body['conversations'])) return null
  const slot = (body['conversations'] as Rec)[conversationId]
  if (!isRecord(slot)) return { items: [] }
  const refs = refsOf(ids, 'todo')
  const items = chainEntries(isRecord(slot['items']) ? slot['items'] : undefined, refs).reverse()
  return { items }
}

/** `#35 agents` 人格：会话 `agent` 实例 → `system_prompt.def` → 提示词文本（缺省 null）。 */
export function personaOf(ids: Json, conversation: Rec | null): string | null {
  const agentId = conversation !== null ? asString(conversation['agent']) : null
  if (agentId === null) return null
  const body = bodyOf(ids, 'agents')
  if (body === null) return null
  const refs = refsOf(ids, 'agents')
  const instances = chainEntries(isRecord(body['instances']) ? body['instances'] : undefined, refs)
  const instance = instances.find((item) => item['id'] === agentId)
  if (instance === undefined) return null
  const promptRef = isRecord(instance['system_prompt']) ? (instance['system_prompt'] as Rec) : null
  const hash = promptRef !== null ? defHashOf(promptRef) : null
  if (hash === null) return null
  const prompt = refs[hash]
  return isRecord(prompt) ? asString(prompt['text']) : null
}

/** `#37 mcp` 外部工具清单（body.tools 数组；缺失 null）。 */
export function mcpToolsOf(ids: Json): Json | null {
  const body = bodyOf(ids, 'mcp')
  if (body === null || !Array.isArray(body['tools'])) return null
  return body['tools']
}

export interface InterpretBagInput {
  ids: Json
  wiring: Wiring
  slot: Json
  conversation: Rec | null
  conversationId: string | null
  config: Rec
  thread: string
  /** 会话 body 覆盖（如已并入生成的标题）；缺省取投影 `ids.session.body`。 */
  sessionBody?: Rec
}

/**
 * 装配 #33 `interpret` 的 bag（`chat.send` 契约）：一次覆盖全部节点所需切片。
 * 仅当对应身份在投影里才落键；缺省身份由 #33 回落包内种子 / 内建兜底。
 */
export function buildInterpretBag(params: InterpretBagInput): Rec {
  const { ids, wiring, slot, conversation, conversationId, config, thread } = params
  const sessionBody = params.sessionBody ?? bodyOf(ids, 'session') ?? {}
  const sessionEntry = entryOf(ids, 'session')
  const sessionDataGen = sessionEntry !== null && sessionEntry['data_gen'] !== undefined ? sessionEntry['data_gen'] : null
  const bag: Rec = {
    input: inputOf(slot),
    input_body: bodyOf(ids, 'input') ?? {},
    config,
    thread,
    thread_kind: conversation !== null ? asString(conversation['kind']) ?? 'main' : 'main',
    session: sessionSlice(sessionBody, conversation, refsOf(ids, 'session'), sessionDataGen),
  }
  const tier = tierOf(ids)
  if (tier !== null) bag['tier'] = tier
  if (conversationId !== null) bag['session_id'] = conversationId
  const memories = memoriesOf(ids, conversation, wiring)
  if (Object.keys(memories).length > 0) bag['memories'] = memories
  const graph = graphSliceOf(ids)
  if (graph !== null) bag['graph'] = graph
  const workspace = workspaceOf(ids, conversation)
  if (workspace.id !== null) bag['workspace_id'] = workspace.id
  if (workspace.root !== null) bag['workspace_root'] = workspace.root
  const ledger = ledgerSliceOf(ids)
  if (ledger !== null) {
    bag['evidence'] = ledger
    bag['evolution'] = ledger
  }
  // #32 审批队列切片：`approval.wait` 入队要按当前 tail 追加（否则每次入队重置队列、丢未决项）。
  const approval = entryOf(ids, 'approval')
  if (approval !== null) {
    bag['approval'] = {
      queue: isRecord(approval['body']) ? approval['body'] : null,
      refs: refsOf(ids, 'approval'),
    }
  }
  // #48 提问队列切片：工具 `question` 入队同上（形状对齐 #48 `readQueueArgs` 的 `{body, refs}`）。
  const question = entryOf(ids, 'question')
  if (question !== null) {
    bag['question'] = {
      body: isRecord(question['body']) ? question['body'] : null,
      refs: refsOf(ids, 'question'),
    }
  }
  const todo = todoSliceOf(ids, conversationId)
  if (todo !== null) bag['todo'] = todo
  const guardRules = bodyOf(ids, 'guard')
  if (guardRules !== null) bag['guard_rules'] = guardRules
  const sandboxTiers = bodyOf(ids, 'sandbox')
  if (sandboxTiers !== null) bag['sandbox_tiers'] = sandboxTiers
  const toolsBody = bodyOf(ids, 'tools')
  if (toolsBody !== null) bag['tools_bindings'] = toolsBody
  const mcpTools = mcpToolsOf(ids)
  if (mcpTools !== null) bag['mcp_tools'] = mcpTools
  const persona = personaOf(ids, conversation)
  if (persona !== null) bag['persona'] = persona
  const skills = skillsOf(ids)
  if (sliceEnabled(wiring, 'skill') && skills !== null) bag['skills'] = skills
  const style = styleOf(ids)
  if (sliceEnabled(wiring, 'style') && style !== null) bag['style'] = style
  if (sliceEnabled(wiring, 'prompt')) bag['system_prompt'] = wiring.system_prompt
  // 缺省工具 schema 只在非空时落键：空数组会被 #27 当作「预建空目录」而屏蔽真实工具目录，
  // #33 会在 context.assemble 处经 `tools.list` 装配目录。
  if (Array.isArray(wiring.tools) && wiring.tools.length > 0) bag['tools'] = wiring.tools
  if (sliceEnabled(wiring, 'recall')) bag['recall'] = []
  return bag
}

/** 首条用户消息判定：标题仍为缺省且 `count == 0`。 */
export function shouldGenerateTitle(conversation: Rec | null, titleDefault: string): boolean {
  if (conversation === null) return false
  const title = asString(conversation['title']) ?? titleDefault
  const count = numberField(conversation['count']) ?? 0
  return title === titleDefault && count === 0
}

/** `#49 session-title.generate` 的 args：首条消息 + 连接实例 + 会话 body。 */
export function buildTitleArgs(params: {
  conversationId: string
  firstMessage: string
  config: Rec
  sessionBody: Rec
  titleDefault: string
}): Rec {
  const { conversationId, firstMessage, config, sessionBody, titleDefault } = params
  const args: Rec = {
    conversation: conversationId,
    first_message: firstMessage,
    config,
    session: sessionBody,
    title_default: titleDefault,
  }
  const vendor = asString(config['vendor'])
  const model = asString(config['model'])
  if (vendor !== null) args['vendor'] = vendor
  if (model !== null) args['model'] = model
  if (isRecord(config['params'])) args['params'] = config['params']
  return args
}

/** 首条用户消息文本（title 段用）。 */
export function firstMessageOf(slot: Json): string {
  const slotRec = isRecord(slot) ? slot : {}
  return asString(slotRec['text']) ?? asString(slotRec['content']) ?? ''
}
