// 展示投影（纯函数，展示形状）：唯一真源是会话回合日志（`session.turns[].steps`，append-only）。
//
// 扁平事件流口径：回合日志按追加序即一条单一直流——`turn.open` 的用户消息、每个 `step.result`
// 的助手本步增量、`step.user` 的运行中插入、`checkpoint` 步派生的 verify / subagent 标记都是同级事件。
// 本模块把某回合的步记录摊平成有序 `StreamEvent[]`（`flattenTurnEvents`），展示链与时间线
// 都是它之上的纯投影：
//   - 展示链（`displayMessagesByTurn`）：一条事件一条消息，**一个回合的助手输出塌成一条消息**，
//     只有 `step.user` 运行中插入才把它切断为「插入前 / 插入后」两段；插入的 user 依追加序落位。
//   - 时间线（`displayTimeline`）：用户 / 推理 / 正文 / 工具卡 / verify / subagent 依序落项。
//
// 助手段口径：同一回合的多个 `step.result`（承接帧、工具派发回填帧、下一个模型调用……）都是
// **同一条**助手消息的增量——工具卡按 `call_id` 原位覆盖、文本 / 推理按到达序追加，绝不每轮新开一条
// （否则每轮一层、每层一个复制 UI）。`content` 是纯文本步的唯一载体（该步增量全为文本时不落 `parts`），
// 故合并时按需补成 text part，保证塌成一条后正文不丢。
//
// 只读展示形状：`turn.open.user_message.content/parts/attachments`、`step.result.assistant.content/parts`、
// `step.user.user_message` 与 `checkpoint.summary`。不读世界、不取时钟；结果确定。

import type { Json, Rec } from './store.ts'

export interface DisplayMessage {
  hash: string
  def: Rec
}

export interface DisplayTurn {
  turnId: string
  messages: DisplayMessage[]
}

export interface DisplayTimelineItem {
  kind: string
  [key: string]: Json
}

export interface DisplayTurnTimeline {
  turn_id: string
  at: Json
  state: Json
  outcome: Json
  index: number
  items: DisplayTimelineItem[]
}

/** 扁平事件流的同级事件（展示投影的输入单位）：`user` / `assistant` / `verify` / `subagent`。 */
export interface StreamEvent {
  kind: 'user' | 'assistant' | 'verify' | 'subagent'
  turn_id: string
  /** 分支 / 多 agent 元数据：本事件的前一事件键（回合内首事件为 null）。 */
  parent: string | null
  at: Json
  /** user / assistant 事件对应的展示消息 def。 */
  def?: Rec
  /** assistant 事件的**本段增量** parts。 */
  parts?: Json[]
  /** 非消息事件（verify / subagent）的确定文本。 */
  text?: string
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stepsOf(turn: Rec): Rec[] {
  const steps = turn['steps']
  return Array.isArray(steps) ? steps.filter(isRecord) : []
}

function stepSeq(step: Rec): number {
  return typeof step['seq'] === 'number' && Number.isFinite(step['seq']) ? (step['seq'] as number) : 0
}

/** 回合用户消息 def（id 与 `session` 的消息链口径一致）。 */
function userDef(conv: string, turn: Rec): Rec | null {
  const user = isRecord(turn['user_message']) ? turn['user_message'] : null
  if (user === null) return null
  const def: Rec = {
    id: `msg-${conv}-${turn['turn_id'] as string}-user`,
    role: 'user',
    content: asString(user['content']) ?? '',
    at: (turn['at'] ?? null) as Json,
  }
  if (Array.isArray(user['parts'])) def['parts'] = user['parts']
  if (Array.isArray(user['attachments'])) def['attachments'] = user['attachments']
  return def
}

/** 插入的用户消息 def（id 用插入幂等键去重）。 */
function insertDef(conv: string, turn: Rec, step: Rec): Rec | null {
  const message = isRecord(step['user_message']) ? (step['user_message'] as Rec) : null
  if (message === null) return null
  const insertId = asString(step['insert_id']) ?? `${stepSeq(step)}`
  const def: Rec = {
    id: `msg-${conv}-${turn['turn_id'] as string}-user-${insertId}`,
    role: 'user',
    content: asString(message['content']) ?? '',
    at: (message['at'] ?? turn['at'] ?? null) as Json,
  }
  if (Array.isArray(message['parts'])) def['parts'] = message['parts']
  if (Array.isArray(message['attachments'])) def['attachments'] = message['attachments']
  return def
}

/** 助手展示 parts（reasoning / text / tool 按到达序）。 */
function assistantParts(assistant: Rec): Json[] {
  return Array.isArray(assistant['parts']) ? (assistant['parts'] as Json[]) : []
}

/** 结构化摘要渲染成确定文本（缺字段跳过）。 */
function renderSummary(summary: Rec): string {
  const lines: string[] = []
  const goal = asString(summary['goal'])
  if (goal !== null) lines.push(`目标：${goal}`)
  const list = (key: string, label: string): void => {
    const value = summary[key]
    if (!Array.isArray(value) || value.length === 0) return
    lines.push(`${label}：`)
    for (const item of value) {
      const text = itemText(item)
      if (text !== null) lines.push(`- ${text}`)
    }
  }
  list('constraints', '约束')
  list('decisions', '决策')
  list('findings', '发现')
  list('files', '涉及文件')
  list('open_questions', '未决问题')
  list('next_steps', '下一步')
  list('errors_to_avoid', '应避免的错误')
  list('user_preferences', '用户偏好')
  return lines.join('\n')
}

function itemText(item: unknown): string | null {
  if (typeof item === 'string') return item.length > 0 ? item : null
  if (!isRecord(item)) return null
  for (const key of ['what', 'claim', 'path', 'step', 'text', 'summary']) {
    const value = item[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * 把一条 `checkpoint` 步映射为展示事件；`segment` 标记不入展示（纯引擎内部步），
 * 结构缺失 / 文本为空同样跳过。返回 null 表示本步不产生展示事件。
 */
function checkpointEvent(turnId: string, step: Rec, at: Json): Omit<StreamEvent, 'parent'> | null {
  const summary = isRecord(step['summary']) ? (step['summary'] as Rec) : null
  if (summary === null) return null
  const kind = summary['kind']
  if (kind === 'segment') return null
  if (kind === 'verify') {
    const text = asString(summary['text'])
    return text === null ? null : { kind: 'verify', turn_id: turnId, at, text }
  }
  if (kind === 'subagent') {
    const text = renderSummary(summary)
    return text.length === 0 ? null : { kind: 'subagent', turn_id: turnId, at, text }
  }
  return null
}

/**
 * 单个回合 → 扁平有序事件流（追加序即真源）。
 *
 * 助手**塌成一条**（每回合一个助手段），只有 `step.user` 运行中插入才把它切成「插入前 / 插入后」
 * 两段（插入的 user 必须就地落在其前后助手之间，否则正文会被排到插入消息之后）。对两种落盘口径
 * 都成立：
 *   - 新口径：`step.result.assistant.parts` 是**本步增量**。
 *   - 旧口径：parts 是整回合**累积前缀**（历史日志）。
 * 做法：维护跨步的「已渲染段」累计 `rendered`，对每步 parts 取「尚未渲染的增量」(`subtract`) 后并入
 * 当前助手段——工具卡同 `call_id` 原位覆盖（结果回填保留首个 render / 位置），文本 / 推理按到达序追加。
 * 纯文本步不落 `parts`（增量全为文本）：其正文只住 `content`，故按需补一条 text part，塌成一条后正文不丢。
 */
export function flattenTurnEvents(conv: string, turn: Rec): StreamEvent[] {
  const turnId = asString(turn['turn_id']) ?? ''
  const turnAt = (turn['at'] ?? null) as Json
  const out: StreamEvent[] = []
  // 返回入列后的同一对象：助手段随后原地追加增量（`parts` 原地更新），不可只留入列时的快照。
  const push = (event: Omit<StreamEvent, 'parent'>): StreamEvent => {
    const parent = out.length > 0 ? streamKeyOf(out[out.length - 1]) : null
    const full: StreamEvent = { ...event, parent }
    out.push(full)
    return full
  }

  const user = userDef(conv, turn)
  if (user !== null) push({ kind: 'user', turn_id: turnId, at: (user['at'] ?? turnAt) as Json, def: user })

  let cur: Rec | null = null
  let curEvent: StreamEvent | null = null
  let rendered: Json[] = []
  let prevContent = ''
  let segment = 0
  // 工具卡全局去重：call_id → 首次出现段持有的**同一** part 对象。后续步（含 `step.user` 切断后的新段）
  // 只回填其结果 / 补 render，不另开一张重复卡——否则同一调用会跨「插入前 / 插入后」两段各出现一次。
  const toolHome = new Map<string, Json>()
  for (const step of stepsOf(turn)) {
    const type = step['type']
    if (type === 'step.result') {
      const assistant = isRecord(step['assistant']) ? (step['assistant'] as Rec) : null
      if (assistant === null) continue
      const content = asString(assistant['content']) ?? ''
      const parts = assistantParts(assistant)
      if (parts.length === 0 && content.length === 0) continue
      // 文本 / 推理按出现次数取增量（旧口径自动切掉累积前缀）；工具卡单列按 call_id 去重。
      const toolParts = parts.filter(isToolPart)
      const textParts = parts.filter((part) => !isToolPart(part))
      const textDelta = subtractRendered(rendered, textParts)
      rendered = mergeToolParts(rendered, textDelta)
      // 工具卡：首次出现的段持有；已出现过则原位回填结果 / 状态 / render（render 缺失时补齐）。
      const newTools: Json[] = []
      for (const part of toolParts) {
        const callId = String(part['call_id'] ?? '')
        const home = toolHome.get(callId)
        if (home !== undefined) {
          if (part['result'] !== undefined) home['result'] = part['result']
          if (part['status'] !== undefined) home['status'] = part['status']
          if (part['render'] !== undefined && part['render'] !== null) home['render'] = part['render']
          if ((home['args'] === undefined || home['args'] === null) && part['args'] !== undefined) home['args'] = part['args']
          if ((home['tool'] === undefined || home['tool'] === '') && typeof part['tool'] === 'string') home['tool'] = part['tool']
          continue
        }
        toolHome.set(callId, part)
        newTools.push(part)
        rendered = mergeToolParts(rendered, [part])
      }
      // 本步新正文：新口径即本步正文，旧口径切掉累积前缀（`content` 相同则无新增）。
      const newContent =
        content === prevContent ? '' : content.startsWith(prevContent) ? content.slice(prevContent.length) : content
      prevContent = content
      if (cur === null || curEvent === null) {
        segment += 1
        cur = {
          id: `msg-${conv}-${turnId}-assistant-${segment}`,
          role: 'assistant',
          content: '',
          at: turnAt,
        }
        curEvent = push({ kind: 'assistant', turn_id: turnId, at: turnAt, def: cur, parts: [] })
      }
      // 并入本步增量：文本 / 推理按到达序追加，工具卡只并入首次出现的。
      let merged = mergeToolParts(curEvent.parts ?? [], textDelta)
      if (newTools.length > 0) merged = mergeToolParts(merged, newTools)
      // 纯文本步（无 parts）只把正文落在 content：补一条 text part，塌成一条后正文仍可见。
      if (newContent.length > 0 && !textDelta.some((part) => isRecord(part) && part['type'] === 'text')) {
        merged = mergeToolParts(merged, [{ type: 'text', text: newContent }])
      }
      curEvent.parts = merged
      cur['parts'] = merged
      if (newContent.length > 0) cur['content'] = (asString(cur['content']) ?? '') + newContent
      continue
    }
    if (type === 'step.user') {
      const def = insertDef(conv, turn, step)
      if (def !== null) push({ kind: 'user', turn_id: turnId, at: (def['at'] ?? turnAt) as Json, def })
      // 插入切断助手段：其后助手回复新开一段。`rendered` / `prevContent` 不重置——
      // 旧口径的 parts / content 是整回合累积前缀，重置会把已渲染内容当增量重复追加。
      cur = null
      curEvent = null
      continue
    }
    if (type === 'checkpoint') {
      const event = checkpointEvent(turnId, step, turnAt)
      if (event !== null) push(event)
    }
  }
  return out
}

/** 键序无关的规范化 JSON（跨段重建后键序可能不同）。 */
function stableKey(value: Json): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableKey(item)).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * 相对已渲染段 `rendered` 取增量：文本 / 推理块按出现次数取值（同文多块不误合并）；
 * 工具卡按 `call_id` 判，内容变（结果回填）则重写。
 */
function subtractRendered(rendered: Json[], full: Json[]): Json[] {
  const prevTools = new Map<string, Json>()
  const prevText = new Map<string, number>()
  for (const part of rendered) {
    if (isRecord(part) && part['type'] === 'tool') prevTools.set(String(part['call_id'] ?? ''), part)
    else {
      const key = stableKey(part)
      prevText.set(key, (prevText.get(key) ?? 0) + 1)
    }
  }
  const out: Json[] = []
  const seen = new Map<string, number>()
  for (const part of full) {
    if (isRecord(part) && part['type'] === 'tool') {
      const before = prevTools.get(String(part['call_id'] ?? ''))
      if (before === undefined || stableKey(before) !== stableKey(part)) out.push(part)
      continue
    }
    const key = stableKey(part)
    const used = seen.get(key) ?? 0
    seen.set(key, used + 1)
    if (used >= (prevText.get(key) ?? 0)) out.push(part)
  }
  return out
}

/** 是否为工具卡 part。 */
function isToolPart(part: Json): boolean {
  return isRecord(part) && part['type'] === 'tool'
}

/** 工具卡按 `call_id` 原位覆盖合并（增量回填），非工具块按到达序追加。 */
function mergeToolParts(base: Json[], delta: Json[]): Json[] {
  const merged = [...base]
  for (const part of delta) {
    if (isRecord(part) && part['type'] === 'tool') {
      const index = merged.findIndex(
        (item) => isRecord(item) && item['type'] === 'tool' && item['call_id'] === part['call_id'],
      )
      if (index >= 0) merged[index] = part
      else merged.push(part)
      continue
    }
    merged.push(part)
  }
  return merged
}

/** 事件键：消息事件取 def.id，非消息事件取 `turn_id:kind:text`（parent 串联用）。 */
function streamKeyOf(event: StreamEvent): string {
  const id = event.def?.['id']
  return typeof id === 'string' ? id : `${event.turn_id}:${event.kind}:${event.text ?? ''}`
}

/** 展示序消息链（旧 → 新），按回合分组；`prev` 跨回合串成链。 */
export function displayMessagesByTurn(conv: string, turns: Rec[]): DisplayTurn[] {
  const groups: DisplayTurn[] = []
  let prev: string | null = null
  for (const turn of turns) {
    const turnId = asString(turn['turn_id'])
    if (turnId === null) continue
    const messages: DisplayMessage[] = []
    for (const event of flattenTurnEvents(conv, turn)) {
      if (event.kind !== 'user' && event.kind !== 'assistant') continue
      const def = event.def
      if (def === undefined) continue
      def['prev'] = prev === null ? null : { def: prev }
      prev = def['id'] as string
      messages.push({ hash: def['id'] as string, def })
    }
    groups.push({ turnId, messages })
  }
  return groups
}

/** 助手事件 parts → 时间线条目（reasoning / text / tool 依序）。 */
function pushAssistantItems(items: DisplayTimelineItem[], event: StreamEvent): void {
  const parts = event.parts ?? []
  const content = event.def !== undefined ? asString(event.def['content']) : null
  if (parts.length === 0 && content !== null) {
    items.push({ kind: 'text', text: content })
    return
  }
  for (const part of parts) {
    if (!isRecord(part)) continue
    const type = part['type']
    if (type === 'reasoning' && typeof part['text'] === 'string') {
      items.push({ kind: 'reasoning', text: part['text'] as string })
      continue
    }
    if (type === 'text' && typeof part['text'] === 'string') {
      items.push({ kind: 'text', text: part['text'] as string })
      continue
    }
    if (type === 'tool') {
      items.push({
        kind: 'tool',
        call_id: (part['call_id'] ?? null) as Json,
        tool: (part['tool'] ?? '') as Json,
        args: (part['args'] ?? null) as Json,
        render: (part['render'] ?? null) as Json,
        result: (part['result'] ?? null) as Json,
        status: (part['status'] ?? null) as Json,
      })
    }
  }
}

/** 回合展示时间线：用户 / 推理 / 正文 / 工具卡 / verify 与 subagent 标记（依追加序）。 */
export function displayTimeline(turns: Rec[]): DisplayTurnTimeline[] {
  const out: DisplayTurnTimeline[] = []
  turns.forEach((turn, index) => {
    const turnId = asString(turn['turn_id']) ?? ''
    const items: DisplayTimelineItem[] = []
    for (const event of flattenTurnEvents('', turn)) {
      if (event.kind === 'user') {
        const text = event.def !== undefined ? asString(event.def['content']) : null
        if (text !== null) items.push({ kind: 'user', text })
        continue
      }
      if (event.kind === 'assistant') {
        pushAssistantItems(items, event)
        continue
      }
      if (event.kind === 'verify' || event.kind === 'subagent') {
        if (event.text !== undefined) items.push({ kind: event.kind, text: event.text })
      }
    }
    out.push({
      turn_id: turnId,
      at: (turn['at'] ?? null) as Json,
      state: (turn['state'] ?? null) as Json,
      outcome: (turn['outcome'] ?? null) as Json,
      index,
      items,
    })
  })
  return out
}
