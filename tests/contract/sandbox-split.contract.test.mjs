// 接缝契约：`sandbox` 门面 → `sandbox-policy` / `sandbox-exec` / `sandbox-fs` 的委派边界。
// 门面为真实 Rust 服务（`execute/launch.mjs` 拉起 release 二进制）；提供方在此按外部边界桩应答，
// 只验证门面的路由 / 判定注入 / `capabilities` 合并 / 错误回落，不启动提供方进程。
// 二进制缺失时跳过（本仓库开发机需先 `cd plugins/sandbox; cargo build --release`）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFrameDecoder, encodeFrame, SERVICE_PROTOCOL_VERSION } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'sandbox')
const BIN = process.platform === 'win32' ? 'sandbox.exe' : 'sandbox'
const BINARY = join(PLUGIN_DIR, 'target', 'release', BIN)
const FIXED_ENV = { run: 'run-seam', thread: 't1', now: 1_700_000_000_000 }

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 启动真实门面服务，并按 `routes` 桩应答其反向 `port.call`。
 * 路由键为 `<port>.<method>`；返回值为 `{ok:true,value}` / `{ok:false,code,message}`。
 */
function startFacade(routes, fallback) {
  const child = spawn(process.execPath, ['execute/launch.mjs'], {
    cwd: PLUGIN_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = createFrameDecoder()
  const pending = new Map()
  const portCalls = []
  const stderr = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  function respond(message, response) {
    const base = {
      v: SERVICE_PROTOCOL_VERSION,
      id: typeof message.id === 'string' ? message.id : '',
    }
    if (response !== null && response.ok === true) {
      child.stdin.write(
        encodeFrame({ ...base, kind: 'port.result', value: response.value ?? null }),
      )
      return
    }
    child.stdin.write(
      encodeFrame({
        ...base,
        kind: 'port.error',
        error: (response && response.code) || 'port_failed',
        message: (response && response.message) || '',
      }),
    )
  }

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (!isRecord(message)) continue
      if (message.kind === 'port.call') {
        portCalls.push(message)
        const key = `${message.port}.${message.method}`
        const handler = routes[key] ?? fallback
        const response =
          handler === undefined ? { ok: false, code: 'unresolved_cap' } : handler(message)
        respond(message, response)
        continue
      }
      const handler = typeof message.id === 'string' ? pending.get(message.id) : undefined
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  let seq = 0
  function call(method, args, callEnv) {
    seq += 1
    const id = `seam-${seq}`
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectCall(new Error(`timeout waiting for ${method}; stderr=${stderr.join('')}`))
      }, 20000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolveCall(message)
      })
      child.stdin.write(
        encodeFrame({
          v: SERVICE_PROTOCOL_VERSION,
          id,
          kind: 'call',
          port: 'sandbox',
          method,
          args,
          env: callEnv ?? FIXED_ENV,
        }),
      )
    })
  }

  return {
    child,
    portCalls,
    stderr,
    exit,
    call,
    close: () => child.stdin.end(),
  }
}

async function stopFacade(service) {
  try {
    service.close()
  } catch {
    // 已退出
  }
  await Promise.race([service.exit, new Promise((r) => setTimeout(r, 3000))])
  if (service.child.exitCode === null) service.child.kill()
}

const skip = existsSync(BINARY) ? false : `sandbox release 二进制缺失：${BINARY}`

test('门面 fsop：先解析判定并注入 resolved，再转发执行方', { skip }, async () => {
  const seen = {}
  const service = startFacade({
    'sandbox-policy.resolve': (message) => {
      seen.policyArgs = message.args
      seen.policyCallId = message.call_id
      return { ok: true, value: { deny_tier: false, fs_read: 'workspace', fs_write: 'none' } }
    },
    'sandbox-fs.fsop': (message) => {
      seen.fsopArgs = message.args
      return { ok: true, value: { ok: true, op: 'read', result: { text: 'hi' } } }
    },
  })
  try {
    const frame = await service.call('fsop', { op: 'read', path: 'a.txt' })
    assert.equal(frame.kind, 'result')
    assert.deepEqual(frame.value, { ok: true, op: 'read', result: { text: 'hi' } })
    assert.deepEqual(seen.policyArgs, { op: 'read', path: 'a.txt' })
    assert.deepEqual(seen.fsopArgs.resolved, {
      deny_tier: false,
      fs_read: 'workspace',
      fs_write: 'none',
    })
    assert.equal(seen.policyCallId, 'seam-1', '反向调用回带正向帧 id 以配对 env')
  } finally {
    await stopFacade(service)
  }
})

test('门面 exec_poll：直接转发执行方，不触判定', { skip }, async () => {
  const ports = []
  const service = startFacade({
    'sandbox-exec.exec_poll': (message) => {
      ports.push(`${message.port}.${message.method}`)
      return { ok: true, value: { output: '', next_cursor: 0, running: false } }
    },
    'sandbox-policy.resolve': () => {
      ports.push('sandbox-policy.resolve')
      return { ok: true, value: {} }
    },
  })
  try {
    const frame = await service.call('exec_poll', { task_id: 't1' })
    assert.equal(frame.kind, 'result')
    assert.deepEqual(ports, ['sandbox-exec.exec_poll'])
  } finally {
    await stopFacade(service)
  }
})

test('门面 capabilities：合并 exec 平台自述与 fs 文本口径', { skip }, async () => {
  const service = startFacade({
    'sandbox-exec.capabilities': () => ({
      ok: true,
      value: {
        platform: 'win32',
        implementations: [],
        default_impl: 'native',
        enforcement: { exec_fs: 'none' },
      },
    }),
    'sandbox-fs.capabilities': () => ({
      ok: true,
      value: { text: { casefold: { unicode: '15.0.0' } } },
    }),
  })
  try {
    const frame = await service.call('capabilities', {})
    assert.equal(frame.kind, 'result')
    assert.equal(frame.value.platform, 'win32')
    assert.deepEqual(frame.value.text, { casefold: { unicode: '15.0.0' } })
  } finally {
    await stopFacade(service)
  }
})

test('门面 fsop：判定不可得时回落转发（不注入 resolved）', { skip }, async () => {
  let fsopArgs
  const service = startFacade({
    'sandbox-policy.resolve': () => ({ ok: false, code: 'not_loaded', message: 'policy down' }),
    'sandbox-fs.fsop': (message) => {
      fsopArgs = message.args
      return { ok: true, value: { ok: true, op: 'stat', result: { exists: false } } }
    },
  })
  try {
    const frame = await service.call('fsop', { op: 'stat', path: 'a.txt' })
    assert.equal(frame.kind, 'result')
    assert.equal(fsopArgs.resolved, undefined)
  } finally {
    await stopFacade(service)
  }
})
