// `todo` 协议级测试的共享驱动与工具：自实现最小帧协议，spawn `node execute/main.ts`。
// 只服务测试（文件名不含 .test，不被 node --test 当用例收集）。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
export const AT = '2023-11-14T22:13:20.000Z'

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
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

export function startService() {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
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
      }, 8000)
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
      return request('hello', { impl: 'todo', gen: 'gen-1' }, 'manifest')
    },
    async call(method, args, env = FIXED_ENV) {
      const message = await request('call', { port: 'todo', method, args, env }, 'result')
      return message.value
    },
    async callRaw(method, args, env = FIXED_ENV) {
      return request('call', { port: 'todo', method, args, env }, ['result', 'error'])
    },
    /** 向任意能力类发一次调用（测未知能力类）。 */
    async callPort(port, method, args, env = FIXED_ENV) {
      return request('call', { port, method, args, env }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
  }
}

/** 取出计划里的 batch 子操作数组。 */
export function opsOf(plan) {
  assert.ok(Array.isArray(plan.$directives), 'plan must carry $directives')
  assert.equal(plan.$directives[0].kind, 'write')
  assert.equal(plan.$directives[0].request.op, 'batch')
  return plan.$directives[0].request.args.ops
}

/** 取出计划末尾的 extern 透传载荷。 */
export function externOf(plan) {
  assert.equal(plan.$directives[1].kind, 'extern')
  return plan.$directives[1].payload
}

// ── 测试内联最小内核助手（测试不得 import 宿主与内核包） ──────────────────────

/** 空链头：首条 entry 的 seq = 0、prev = null。 */
export const EMPTY_HEAD = Object.freeze({ seq: -1, hash: null })

/** 空世界：只有 defs / ids 两层。 */
export const EMPTY_WORLD = Object.freeze({ defs: {}, ids: {} })

/** 规范序列化：键升序、剔除 undefined 键、-0 归一（与内核 canonicalJson 同口径）。 */
function canonical(value) {
  if (value === undefined) throw new Error('undefined')
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value === 0 ? 0 : value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

/** 内容哈希：hex(sha256(utf8(canonicalJson(v))))，全 64 个十六进制字符。 */
export function H(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

/** 批内占位符替换：`{$n:k}` 只指向本批更早的 put 产物。 */
function substitute(value, acc, index) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, acc, index))
  if (value === null || typeof value !== 'object') return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === '$n') {
    const j = value.$n
    if (typeof j !== 'number' || !Number.isInteger(j) || j < 0 || j >= index || acc[j] === null) {
      throw new Error(`bad_selfref $n=${j} at ${index}`)
    }
    return acc[j]
  }
  const out = {}
  for (const key of keys) out[key] = substitute(value[key], acc, index)
  return out
}

/**
 * 最小批处理应用（测试回放用）：支持 `put` / `add_identity` / `add_gen` 与 `$n` 占位；
 * 就地演化传入的世界副本，返回推进后的 head。
 */
export function runBatch(head, world, ops) {
  const acc = []
  for (let index = 0; index < ops.length; index++) {
    const args = substitute(ops[index].args, acc, index)
    if (ops[index].op === 'put') {
      const hash = H(args)
      if (world.defs[hash] === undefined) world.defs[hash] = args
      acc.push(hash)
    } else if (ops[index].op === 'add_identity') {
      if (world.ids[args.id] !== undefined) throw new Error(`id_taken ${args.id}`)
      world.ids[args.id] = { id: args.id, schema: args.schema, gens: [], active: null }
      acc.push(null)
    } else if (ops[index].op === 'add_gen') {
      const identity = world.ids[args.id]
      if (identity === undefined) throw new Error(`no_identity ${args.id}`)
      identity.gens.push({
        seq: identity.gens.length,
        payload: args.payload,
        sig: args.sig,
        pins: args.pins ?? {},
      })
      identity.active = args.payload
      acc.push(null)
    } else {
      throw new Error(`unsupported op ${ops[index].op}`)
    }
  }
  return { world, head: { seq: head.seq + 1, hash: H({ ops }) }, verdict: { ok: true } }
}
