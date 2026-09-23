// `ui-threads` 协议级测试的共享驱动：自实现最小帧协议，spawn `node execute/main.ts`。
// 只服务测试（文件名不含 .test，不被 node --test 当用例收集）。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** 起一个临时 root 与假入站地址（服务连不上宿主也不影响协议级测试）。 */
export function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'chrono-ui-threads-'))
  return {
    root,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-threads'),
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function startService(env) {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const stderr = []
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
    events,
    exit,
    stderr,
    request,
    async hello() {
      return request('hello', { impl: 'ui-threads', gen: 'gen-1' }, 'manifest')
    },
    async call(method, args, env2 = FIXED_ENV) {
      const message = await request('call', { port: 'ui-threads', method, args, env: env2 }, 'result')
      return message.value
    },
    async callRaw(method, args, env2 = FIXED_ENV) {
      return request('call', { port: 'ui-threads', method, args, env: env2 }, ['result', 'error'])
    },
    async callPort(port, method, args, env2 = FIXED_ENV) {
      return request('call', { port, method, args, env: env2 }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
  }
}
