// `short-memory` 协议级测试驱动：自实现最小帧协议，spawn `node execute/main.ts`。
// 可选注入 `dataDir`（④ CHRONO_PLUGIN_DATA）用于持久化 / 残留测试。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

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

export function startService(options = {}) {
  const env = { ...process.env }
  if (options.dataDir !== undefined) env.CHRONO_PLUGIN_DATA = options.dataDir
  else delete env.CHRONO_PLUGIN_DATA
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env })
  const decoder = createDecoder()
  const pending = new Map()
  const stderr = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`))
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
    exit,
    stderr,
    request,
    hello: () => request('hello', { impl: 'short-memory', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'short-memory', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}
