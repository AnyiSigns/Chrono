// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，收集 event 帧。
// 测试前确保原生 tokenizer 已构建（包内 target/release）；服务在无 CHRONO_PLUGIN_STATE 时回落该产物。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeFrame, createFrameDecoder as createDecoder } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

const LIB_NAMES =
  process.platform === 'win32' ? ['tokenizer.dll'] : ['libtokenizer.so', 'tokenizer.so']

/** 确保包内 `target/release/` 有原生库；缺失则跑一次 `cargo build --release`。 */
export function ensureNative() {
  for (const name of LIB_NAMES) {
    if (existsSync(join(PKG_ROOT, 'target', 'release', name))) return
  }
  const result = spawnSync('cargo', ['build', '--release'], { cwd: PKG_ROOT, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`cargo build --release failed: ${result.stderr || result.stdout}`)
  }
}

export { encodeFrame, createDecoder }

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 启动服务并返回请求 / 事件接口。 */
export function startService() {
  ensureNative()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHRONO_PLUGIN_STATE: '' },
  })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', () => {})

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, 15000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  return {
    child,
    events,
    exit,
    request,
    async hello() {
      return request('hello', { impl: 'context-window', gen: 'gen-1' }, 'manifest')
    },
    async build(bag, env = FIXED_ENV) {
      const message = await request('call', { port: 'context', method: 'build', args: bag, env }, 'result')
      return message.value
    },
    async buildRaw(bag, env = FIXED_ENV) {
      return request('call', { port: 'context', method: 'build', args: bag, env }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
  }
}

/** 由消息体数组构造 `prev` 链（head + refs），供历史候选。 */
export function chainOf(messages) {
  const refs = {}
  let prev = null
  let head = null
  for (const message of messages) {
    const hash = Buffer.from(String(message.id)).toString('hex').padEnd(64, '0').slice(0, 64)
    refs[hash] = { ...message, prev: prev === null ? null : { def: prev } }
    prev = hash
    head = hash
  }
  return { head, refs, turns: turnsFromMessages(messages) }
}

function callsOf(message) {
  const calls = []
  const parts = Array.isArray(message.parts) ? message.parts : []
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'tool') {
      const id = typeof part.call_id === 'string' ? part.call_id : null
      if (id !== null) calls.push({ id, name: part.tool ?? '', arguments: part.args ?? {} })
      continue
    }
    if (part.type === 'tool_call' || part.type === 'tool_use') {
      const id = part.id ?? part.call_id ?? `call-${calls.length}`
      calls.push({ id, name: part.name ?? part.tool ?? '', arguments: part.arguments ?? part.args ?? {} })
    }
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (call === null || typeof call !== 'object') continue
    const id = call.id ?? call.call_id
    if (typeof id !== 'string') continue
    calls.push({ id, name: call.name ?? '', arguments: call.arguments ?? call.args ?? {} })
  }
  return calls
}

function parsedToolContent(content) {
  if (typeof content !== 'string') return null
  try {
    const parsed = JSON.parse(content)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.call_id === 'string'
      ? parsed
      : null
  } catch {
    return null
  }
}

/**
 * 把平铺的展示消息推断成回合步日志（模型形状），供新投影消费：
 * 每条 user 消息起一个新回合；assistant 的 `parts` 工具卡 / `tool_calls` 落成 step.intent + step.result；
 * 紧随的 `role:'tool'` 消息按其 call_id 回填结果。
 */
export function turnsFromMessages(messages) {
  const turns = []
  let current = null
  const ensureTurn = () => {
    if (current === null) {
      current = { turn_id: `t${turns.length + 1}`, user: null, assistant: [], tools: [] }
      turns.push(current)
    }
    return current
  }
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'user') {
      current = { turn_id: `t${turns.length + 1}`, user: message, assistant: [], tools: [] }
      turns.push(current)
      continue
    }
    const turn = ensureTurn()
    if (message.role === 'tool') turn.tools.push(message)
    else turn.assistant.push(message)
  }

  return turns.map((turn) => {
    const steps = []
    let seq = 0
    for (const message of turn.assistant) {
      seq += 1
      const calls = callsOf(message)
      const parts = Array.isArray(message.parts) ? message.parts : []
      const assistant = { content: typeof message.content === 'string' ? message.content : '' }
      if (typeof message.from === 'string') assistant.from = message.from
      if (parts.length > 0) assistant.parts = parts
      const toolResults = []
      for (const card of parts) {
        if (card === null || typeof card !== 'object' || card.type !== 'tool') continue
        const callId = typeof card.call_id === 'string' ? card.call_id : null
        if (callId === null) continue
        if (card.status === null && card.result === null) continue
        const ok = card.status !== 'error'
        toolResults.push(ok ? { call_id: callId, ok: true, result: card.result ?? null } : { call_id: callId, ok: false, error: card.result ?? null })
      }
      if (calls.length > 0) {
        steps.push({ type: 'step.intent', turn_id: turn.turn_id, seq, kind: 'tool.dispatch', tool_calls: calls })
        steps.push({ type: 'step.result', turn_id: turn.turn_id, seq, assistant, tool_results: toolResults })
      } else {
        steps.push({ type: 'step.result', turn_id: turn.turn_id, seq, assistant, tool_results: toolResults })
      }
    }
    // 独立 tool 消息：按其 call_id 回填到最近的 step.result。
    for (const message of turn.tools) {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : null
      const parsed = parsedToolContent(message.content)
      const result = parsed ?? (typeof message.content === 'string' ? { call_id: callId ?? `call-${seq}`, ok: true, result: message.content } : null)
      if (result === null) continue
      let target = null
      for (const step of steps) if (step.type === 'step.result') target = step
      if (target === null) {
        seq += 1
        steps.push({ type: 'step.result', turn_id: turn.turn_id, seq, assistant: { content: '' }, tool_results: [result] })
      } else {
        target.tool_results.push(result)
      }
    }
    const out = { turn_id: turn.turn_id, conv: 'c1', at: '2026-01-01T00:00:00.000Z', state: 'settled', outcome: { kind: 'committed', retryable: false }, steps }
    if (turn.user !== null) {
      const user = { content: typeof turn.user.content === 'string' ? turn.user.content : '' }
      if (Array.isArray(turn.user.parts)) user.parts = turn.user.parts
      if (Array.isArray(turn.user.attachments)) user.attachments = turn.user.attachments
      if (typeof turn.user.from === 'string') user.from = turn.user.from
      out.user_message = user
    }
    return out
  })
}

/** 基础 bag：默认预算 850（1000 - 100 - 50），支持所有输入模态。 */
export function baseBag(overrides = {}) {
  return {
    input: 'hi',
    system_prompt: 'sys',
    tools: [],
    memories: {},
    session: { head: null, refs: {}, turns: [] },
    config: {
      model: 'm1',
      context_window: 1000,
      max_output: 100,
      modalities: { input: ['text', 'image', 'audio', 'file'] },
    },
    ...overrides,
  }
}

/** 文本消息内容（非文本 content 序列化为 JSON 便于断言）。 */
export function contentOf(message) {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}
