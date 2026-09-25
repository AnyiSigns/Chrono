// 最小服务协议驱动（测试内实现，不 import 宿主 / 内核）：spawn `node execute/main.ts`，
// 4 字节大端帧编解码，按 id 配对请求与应答；`env.emitter` 由测试显式给出以验证分库。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export function encodeFrame(message) {
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
  const { port = 'storage-sql', dataDir, env = {} } = options
  const childEnv = { ...process.env, ...env }
  if (dataDir !== undefined) childEnv.CHRONO_PLUGIN_DATA = dataDir
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = createDecoder()
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', () => {})
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

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
    exit,
    request,
    hello: () => request('hello', { impl: port, gen: 'gen-1' }, 'manifest'),
    call: (method, args, emitter = null) =>
      request(
        'call',
        {
          port,
          method,
          args,
          env: { run: null, thread: null, now: 1_700_000_000_000, emitter },
        },
        ['result', 'error'],
      ),
    close: () => child.stdin.end(),
  }
}
