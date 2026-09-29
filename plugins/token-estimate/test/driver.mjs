// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call 帧，收集结果。
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

/** 启动服务并返回请求接口。 */
export function startService() {
  ensureNative()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHRONO_PLUGIN_STATE: '' },
  })
  const decoder = createDecoder()
  const pending = new Map()
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
    exit,
    request,
    async hello() {
      return request('hello', { impl: 'token-estimate', gen: 'gen-1' }, 'manifest')
    },
    async call(method, args) {
      const message = await request(
        'call',
        { port: 'token-estimate', method, args, env: {} },
        'result',
      )
      return message.value
    },
    async callRaw(method, args) {
      return request('call', { port: 'token-estimate', method, args, env: {} }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
  }
}
