// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，收集 event 帧。
// 测试前确保原生 tokenizer 已构建（包内 target/release）；服务在无 CHRONO_PLUGIN_STATE 时回落该产物。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

export function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

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
  return { head, refs }
}

/** 基础 bag：默认预算 850（1000 - 100 - 50），支持所有输入模态。 */
export function baseBag(overrides = {}) {
  return {
    input: 'hi',
    system_prompt: 'sys',
    tools: [],
    memories: {},
    session: { head: null, refs: {} },
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
