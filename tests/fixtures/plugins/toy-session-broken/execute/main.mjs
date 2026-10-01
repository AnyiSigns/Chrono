// 同名 toy 服务：宿主服务协议帧循环（docs/protocol.md §二）。
// 身份 / 能力 / 方法自读同包 plugin.json；行为按身份分派；不读投影、不写世界、不取时间随机。
// stdout 只发协议帧，日志走 stderr；stdin EOF / close / error 即自退出。
import { readFileSync } from 'node:fs'

const PLUGIN = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
const IDENTITY = PLUGIN.identity
const IMPLEMENTS = PLUGIN.implements
const METHODS = PLUGIN.methods
const PROTOCOL = PLUGIN.protocol
const STATE = PLUGIN.state
const BEHAVIOR = readBehavior()

/** 可选 `e2e.json`：按方法覆盖返回值 /
注入错误（测试夹具用于制造失败路径）。 */
function readBehavior() {
  try {
    return JSON.parse(readFileSync(new URL('../e2e.json', import.meta.url), 'utf8'))
  } catch {
    return { errors: {}, values: {} }
  }
}

const WORKSPACE = {
  id: 'w-e2e',
  name: 'e2e',
  path: process.env.CHRONO_PLUGIN_STATE ?? process.cwd(),
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 会话 toy：内存版最小回合日志投影（turn_open / step_append / turn_settle / read / history）。
// 只为 e2e 制造「已发生步骤保留 + 收口失败」的现场；不落盘、不做真实链校验。
const SESSION = { conversations: [], turns: [], current: null }

function sessionTurnOpen(args) {
  const turnId = typeof args.turn_id === 'string' ? args.turn_id : ''
  const slotRef = typeof args.slot_ref === 'string' ? args.slot_ref : ''
  const existing = SESSION.turns.find((turn) => turn.turn_id === turnId || (slotRef !== '' && turn.slot_ref === slotRef))
  if (existing !== undefined) {
    return { ok: true, turn_id: existing.turn_id, conversation: existing.conversation, created: false }
  }
  const spec = isRecord(args.new_conversation) ? args.new_conversation : null
  if (spec !== null && typeof spec.id === 'string') {
    if (!SESSION.conversations.some((conversation) => conversation.id === spec.id)) {
      SESSION.conversations.push({ id: spec.id, workspace_id: spec.workspace_id ?? null, kind: 'main', title: spec.title ?? null, count: 0, head: null })
    }
    SESSION.current = spec.id
  }
  if (typeof SESSION.current !== 'string') return { ok: false, reason: 'no_conversation' }
  const conversation = SESSION.current
  const turn = {
    turn_id: turnId,
    conversation,
    slot_ref: slotRef,
    at: typeof args.at === 'string' ? args.at : null,
    state: 'open',
    outcome: null,
    steps: [],
    user_message: isRecord(args.user_message) ? args.user_message : { role: 'user', content: '' },
  }
  SESSION.turns.push(turn)
  return { ok: true, turn_id: turnId, conversation, created: spec !== null }
}

function sessionStepAppend(args) {
  const turn = SESSION.turns.find((item) => item.turn_id === args.turn_id)
  if (turn === undefined) return { ok: false, reason: 'unknown_turn' }
  if (!turn.steps.some((step) => step.type === args.type && step.seq === args.seq)) turn.steps.push(args)
  return { ok: true, turn_id: turn.turn_id, deduped: false }
}

function sessionTurnSettle(args) {
  const turn = SESSION.turns.find((item) => item.turn_id === args.turn_id)
  if (turn === undefined) return { ok: false, reason: 'unknown_turn' }
  if (turn.state !== 'open') return { ok: false, reason: 'already_settled', rejected: true }
  turn.state = 'settled'
  turn.outcome = args.outcome ?? null
  return { ok: true, turn_id: turn.turn_id, outcome: turn.outcome, persisted: true }
}

function isToolPart(part) {
  return isRecord(part) && part['type'] === 'tool'
}

/** 键序无关的规范化 JSON（跨段比较用）。 */
function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 展示段合并：工具卡按 `call_id` 原位覆盖，文本 / 推理按到达序追加。 */
function mergeParts(base, delta) {
  const merged = [...base]
  for (const part of delta) {
    if (isToolPart(part)) {
      const index = merged.findIndex((item) => isToolPart(item) && item['call_id'] === part['call_id'])
      if (index >= 0) merged[index] = part
      else merged.push(part)
      continue
    }
    merged.push(part)
  }
  return merged
}

/** 相对已渲染段取文本 / 推理增量（工具卡单列，由合并处理）。 */
function subtractRendered(rendered, full) {
  const prevText = new Map()
  for (const part of rendered) {
    if (isToolPart(part)) continue
    const key = stableKey(part)
    prevText.set(key, (prevText.get(key) ?? 0) + 1)
  }
  const out = []
  const seen = new Map()
  for (const part of full) {
    if (isToolPart(part)) continue
    const key = stableKey(part)
    const used = seen.get(key) ?? 0
    seen.set(key, used + 1)
    if (used >= (prevText.get(key) ?? 0)) out.push(part)
  }
  return out
}

/**
 * 回合日志 → 展示消息（与 `plugins/session` 的展示投影同口径）：同一回合的多个 `step.result`
 * 是**同一助手消息**的本步增量——工具卡按 `call_id` 原位覆盖、文本 / 推理按到达序追加，塌成一条。
 * 故收口失败也只丢终态，已落步的助手正文与工具卡仍在（不再什么都不留）。
 */
function turnMessages(conv, turn) {
  const messages = []
  const user = isRecord(turn['user_message']) ? turn['user_message'] : null
  if (user !== null) {
    messages.push({
      id: `msg-${conv}-${turn['turn_id']}-user`,
      role: 'user',
      content: typeof user['content'] === 'string' ? user['content'] : '',
      at: (user['at'] ?? turn['at'] ?? null),
    })
  }
  let current = null
  let rendered = []
  let prevContent = ''
  for (const step of turn['steps']) {
    if (step['type'] !== 'step.result' || !isRecord(step['assistant'])) continue
    const assistant = step['assistant']
    const content = typeof assistant['content'] === 'string' ? assistant['content'] : ''
    const parts = Array.isArray(assistant['parts']) ? assistant['parts'] : []
    if (parts.length === 0 && content.length === 0) continue
    const toolParts = parts.filter(isToolPart)
    const textParts = parts.filter((part) => !isToolPart(part))
    const textDelta = subtractRendered(rendered, textParts)
    rendered = mergeParts(rendered, textDelta)
    rendered = mergeParts(rendered, toolParts)
    // 正文增量：新口径为纯本步正文，旧口径切掉累积前缀（与 `content` 相同则无新增）。
    const newContent =
      content === prevContent ? '' : content.startsWith(prevContent) ? content.slice(prevContent.length) : content
    prevContent = content
    if (current === null) {
      current = { id: `msg-${conv}-${turn['turn_id']}-assistant`, role: 'assistant', content: '', at: turn['at'] ?? null, parts: [] }
      messages.push(current)
    }
    current['parts'] = mergeParts(current['parts'], textDelta)
    current['parts'] = mergeParts(current['parts'], toolParts)
    // 纯文本步（无 parts）只住正文：补一条 text part，塌成一条后正文仍可见。
    if (newContent.length > 0 && !textDelta.some((part) => isRecord(part) && part['type'] === 'text')) {
      current['parts'] = mergeParts(current['parts'], [{ type: 'text', text: newContent }])
    }
    if (newContent.length > 0) current['content'] += newContent
  }
  return messages
}

function sessionHistory(args) {
  const conversation = typeof args.conversation === 'string' ? args.conversation : SESSION.current
  const messages = []
  for (const turn of SESSION.turns) {
    if (turn['conversation'] !== conversation) continue
    messages.push(...turnMessages(conversation, turn))
  }
  messages.reverse()
  return {
    conversation,
    before: args.before ?? null,
    limit: args.limit ?? null,
    messages: messages.map((def) => ({ hash: def['id'], def })),
    next_before: null,
    body: { version: 1, current: SESSION.current, conversations: SESSION.conversations.map((item) => ({ ...item })) },
    refs: {},
    turns: SESSION.turns.map((item) => ({ ...item, steps: item.steps.map((step) => ({ ...step })) })),
  }
}

function sessionBehavior(method, args) {
  const input = isRecord(args) ? args : {}
  switch (method) {
    case 'turn_open':
      return sessionTurnOpen(input)
    case 'step_append':
      return sessionStepAppend(input)
    case 'turn_settle':
      return sessionTurnSettle(input)
    case 'history':
      return sessionHistory(input)
    case 'read':
      return {
        version: 1,
        current: SESSION.current,
        conversations: SESSION.conversations.map((item) => ({ ...item })),
        head: null,
        refs: {},
        turns: SESSION.turns.map((item) => ({ ...item })),
        pending_turns: [],
        open_turns: SESSION.turns.filter((turn) => turn.state === 'open').map((turn) => turn.turn_id),
        data_gen: null,
      }
    case 'set_title': {
      const conversation = SESSION.conversations.find((item) => item.id === input.conversation)
      if (conversation !== undefined) conversation.title = input.title
      return { ok: true }
    }
    default:
      return { ok: true }
  }
}

function behavior(capability, method, args) {
  if (IDENTITY === 'session') return sessionBehavior(method, args)
  if (IDENTITY === 'tool-fs') {
    if (method === 'describe') {
      return {
        ok: true,
        tools: [
          {
            name: 'read',
            intent: '读取一个文本文件的内容。',
            when_to_use: '需要查看文件内容时。',
            param_semantics: { path: '文件路径。' },
            boundaries: '只读单文件。',
            description: '读文本文件；返回 {text}。',
            argsSchema: {
              type: 'object',
              properties: { path: { type: 'string', minLength: 1 } },
              required: ['path'],
              additionalProperties: false,
            },
            caps: { fs: { read: 'workspace', write: 'none' }, net: 'none' },
            idempotent: true,
            render: { form: 'line', label: 'read', summary: '{path}' },
          },
        ],
      }
    }
    const callArgs = isRecord(args) && isRecord(args.args) ? args.args : {}
    const path = typeof callArgs.path === 'string' ? callArgs.path : ''
    return { ok: true, result: { path, text: `toy-read:${path}` } }
  }
  if (IDENTITY === 'sandbox') {
    if (method === 'capabilities') return { ok: true, tiers: ['auto', 'severe', 'review', 'deny'] }
    if (method === 'exec') return { ok: true, code: 0, stdout: '', stderr: '' }
    return { ok: true }
  }
  if (IDENTITY === 'workspace') {
    if (method === 'list' || method === 'read') return { ok: true, workspaces: [WORKSPACE] }
    return { ok: true }
  }
  if (IDENTITY === 'embedding') {
    if (method === 'chunk') return { ok: true, chunks: [] }
    return { ok: true, vectors: [] }
  }
  if (IDENTITY === 'evolve-metrics') return { ok: true }
  return { ok: true }
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function writeFrame(message) {
  process.stdout.write(encodeFrame(message))
}

function log(line) {
  process.stderr.write(`[${IDENTITY}] ${line}\n`)
}

function handle(message) {
  if (!isRecord(message)) return
  switch (message.kind) {
    case 'hello':
      writeFrame({
        v: PROTOCOL,
        id: message.id,
        kind: 'manifest',
        identity: IDENTITY,
        implements: IMPLEMENTS,
        methods: METHODS,
        protocol: PROTOCOL,
        state: STATE,
      })
      return
    case 'probe':
      writeFrame({ v: PROTOCOL, id: message.id, kind: 'pong', ok: true })
      return
    case 'reload':
      writeFrame({ v: PROTOCOL, id: message.id, kind: 'ack' })
      return
    case 'drain':
      writeFrame({ v: PROTOCOL, id: message.id, kind: 'bye' })
      return
    case 'call': {
      const id = typeof message.id === 'string' ? message.id : ''
      const capability = typeof message.port === 'string' ? message.port : ''
      const method = typeof message.method === 'string' ? message.method : ''
      if (!IMPLEMENTS.includes(capability)) {
        writeFrame({ v: PROTOCOL, id, kind: 'error', ok: false, code: 'unresolved_cap', message: `unknown capability ${capability}` })
        return
      }
      const injected = BEHAVIOR.errors?.[method]
      if (injected !== undefined) {
        writeFrame({ v: PROTOCOL, id, kind: 'error', ok: false, code: injected.code, message: injected.message })
        return
      }
      const value = Object.hasOwn(BEHAVIOR.values ?? {}, method) ? BEHAVIOR.values[method] : behavior(capability, method, message.args)
      writeFrame({ v: PROTOCOL, id, kind: 'result', ok: true, value })
      return
    }
    default:
      return
  }
}

let buffered = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0)
    if (buffered.length < 4 + length) break
    const body = buffered.subarray(4, 4 + length).toString('utf8')
    buffered = buffered.subarray(4 + length)
    try {
      handle(JSON.parse(body))
    } catch (err) {
      log(`handle error: ${err.message}`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))

log(`service started (pid ${process.pid})`)
