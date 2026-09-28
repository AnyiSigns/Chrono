// question 卡对账（纯函数，零 react / DOM）：重拉历史后用 `question.state` 的权威状态覆盖卡片
// `answers` / `answered` / `expired`，使已答 / 过期卡片收为只读。
//
// 消息 part 里的 render.detail 只是**入队那一刻**的快照（answers:null / expired:false）；真源在
// question 服务自有存储。对账失败（question 未就绪）时原样保留快照，不阻断历史渲染。

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取消息记录的消息体（历史窗口是 `{hash, def}`；兼容裸 def）。 */
function defOf(entry: unknown): any {
  return isRec(entry) && isRec(entry.def) ? entry.def : entry
}

/** question 卡的 detail（`render.detail.kind === 'question'`）；非 question 卡回 null。 */
function questionDetailOf(part: unknown): any {
  if (!isRec(part) || !isRec(part.render) || !isRec(part.render.detail)) return null
  const detail = part.render.detail
  return detail.kind === 'question' ? detail : null
}

/** 从展示消息里收集 question 卡的 item id（去重、保序）。 */
export function collectQuestionItemIds(messages: unknown): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(messages) ? messages : []) {
    const def = defOf(entry)
    const parts = isRec(def) && Array.isArray(def.parts) ? def.parts : []
    for (const part of parts) {
      const detail = questionDetailOf(part)
      const id = detail === null ? null : detail.id
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }
  return ids
}

/**
 * 用 `question.state` 的 item（`{id, answered, answers, expired}`）覆盖卡片 detail。
 * 已答 ⇒ `interactive:false`；过期保持 `interactive:true`，由渲染器的 `expired` 分支出警告 + 禁用控件。
 * 无匹配 / 无变化原引用返回。
 */
export function applyQuestionStates(view: any, byId: { [id: string]: any }): any {
  if (!isRec(view) || !Array.isArray(view.messages) || Object.keys(byId).length === 0) return view
  let changed = false
  const messages = view.messages.map((entry: any) => {
    const def = defOf(entry)
    if (!isRec(def) || !Array.isArray(def.parts)) return entry
    let partChanged = false
    const parts = def.parts.map((part: any) => {
      const detail = questionDetailOf(part)
      if (detail === null || typeof detail.id !== 'string') return part
      const state = byId[detail.id]
      if (!isRec(state)) return part
      const answers = state.answers ?? null
      const answered = state.answered === true || answers !== null
      const expired = state.expired === true
      const interactive = !answered
      if (
        detail.answers === answers &&
        detail.answered === answered &&
        detail.expired === expired &&
        (detail.interactive !== false) === interactive
      ) {
        return part
      }
      partChanged = true
      return { ...part, render: { ...part.render, detail: { ...detail, answers, answered, expired, interactive } } }
    })
    if (!partChanged) return entry
    changed = true
    const nextDef = { ...def, parts }
    return isRec(entry) && isRec(entry.def) ? { ...entry, def: nextDef } : nextDef
  })
  return changed ? { ...view, messages } : view
}
