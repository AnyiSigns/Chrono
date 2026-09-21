// `tool-shell` 服务协议级测试：spawn `node execute/main.ts`，自实现最小协议驱动，
// 把服务发出的 `port.call`（sandbox.exec / secrets.resolve）桥接到内存假后端。
// 覆盖：握手 / 控制 / 未知方法 / EOF 自退出；describe；invoke 两种 mode；密钥注入；错误透传。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

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

const OK_EXEC = { exit_code: 0, stdout: '', stderr: '', truncated: false, duration_ms: 1, code: null }

function startService(options = {}) {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const portCalls = []
  const events = []
  let stderr = ''
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  const resolvePort =
    options.resolvePort ??
    ((port, method) => (method === 'exec' ? { value: OK_EXEC } : { value: 'plain-secret' }))

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        const outcome = resolvePort(message.port, message.method, message.args)
        const frame = outcome.error
          ? {
              v: '1',
              id: message.id,
              kind: 'port.error',
              ok: false,
              error: outcome.error,
              message: outcome.message ?? outcome.error,
            }
          : { v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome.value }
        child.stdin.write(encodeFrame(frame))
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

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
    portCalls,
    events,
    stderrText: () => stderr,
    request,
    hello: () => request('hello', { impl: 'tool-shell', gen: 'gen-1' }, 'manifest'),
    call: (method, args) =>
      request(
        'call',
        { port: 'tool-shell', method, args, env: { run: 'test-run', thread: 't1', now: 0 } },
        ['result', 'error'],
      ),
    close: () => child.stdin.end(),
  }
}

function baseBag(overrides = {}) {
  return {
    tool: 'shell',
    args: { input: 'echo hi' },
    tier: 'severe',
    workspace_root: 'C:\\ws',
    caps: { fs: { read: 'workspace', write: 'workspace' }, net: 'none' },
    ...overrides,
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'tool-shell')
    assert.deepEqual(manifest.implements, ['tool-shell'])
    assert.deepEqual(manifest.methods['tool-shell'], ['describe', 'invoke'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('未知方法 / 未知能力类 → 结构化 error', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.request('call', { port: 'tool-shell', method: 'nope', args: {} }, 'error')).code, 'unknown_method')
    assert.equal((await drv.request('call', { port: 'other', method: 'describe', args: {} }, 'error')).code, 'unresolved_cap')
  } finally {
    drv.close()
  }
})

test('describe 经服务协议回报单工具 shell', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const described = await drv.call('describe', {})
    assert.equal(described.kind, 'result')
    assert.deepEqual(described.value.tools.map((tool) => tool.name), ['shell'])
    assert.equal(described.value.tools[0].render.detail.kind, 'terminal')
  } finally {
    drv.close()
  }
})

test('invoke command 经反向 port.call 调 sandbox.exec 并回 terminal 结果', async () => {
  const drv = startService({
    resolvePort: () => ({ value: { ...OK_EXEC, stdout: 'hi\n' } }),
  })
  try {
    await drv.hello()
    const result = await drv.call('invoke', baseBag())
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, true)
    assert.equal(result.value.result.kind, 'terminal')
    assert.equal(result.value.result.stdout, 'hi\n')
    const execCall = drv.portCalls.find((call) => call.port === 'sandbox' && call.method === 'exec')
    assert.ok(execCall !== undefined, '应经反向 port.call 调 sandbox.exec')
    assert.equal(execCall.args.cmd, 'cmd.exe')
    assert.equal(execCall.args.tier, 'severe')
  } finally {
    drv.close()
  }
})

test('invoke code 经服务协议回 json 结构化结果', async () => {
  const drv = startService({ resolvePort: () => ({ value: { ...OK_EXEC, stdout: '{"n":2}' } }) })
  try {
    await drv.hello()
    const result = await drv.call('invoke', {
      tool: 'shell',
      args: { mode: 'code', language: 'javascript', input: 'x' },
    })
    assert.equal(result.value.result.kind, 'json')
    assert.deepEqual(result.value.result.value, { n: 2 })
  } finally {
    drv.close()
  }
})

test('invoke 的 auth_ref 经 secrets.resolve；明文只出现在 exec env，不进结果', async () => {
  const secret = 'svc-secret'
  const drv = startService({
    resolvePort: (port, method) => {
      if (port === 'secrets' && method === 'resolve') return { value: secret }
      return { value: OK_EXEC }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('invoke', baseBag({ auth_ref: { kind: 'local', name: 'TOKEN' } }))
    const secretsCall = drv.portCalls.find((call) => call.port === 'secrets')
    assert.ok(secretsCall !== undefined, '应经反向 port.call 调 secrets.resolve')
    assert.deepEqual(secretsCall.args.auth_ref, { kind: 'local', name: 'TOKEN' })
    const execCall = drv.portCalls.find((call) => call.port === 'sandbox')
    assert.deepEqual(execCall.args.env, { TOKEN: secret })
    assert.equal(JSON.stringify(result.value).includes(secret), false, '明文不得进结果')
    assert.equal(drv.events.length, 0, '本插件不发 event')
    assert.equal(drv.stderrText().includes(secret), false, '明文不得进日志')
  } finally {
    drv.close()
  }
})

test('sandbox 前置失败原码透传', async () => {
  const drv = startService({
    resolvePort: (port, method) =>
      method === 'exec' ? { error: 'fs_denied', message: 'outside' } : { value: 'x' },
  })
  try {
    await drv.hello()
    const result = await drv.call('invoke', baseBag())
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'fs_denied')
  } finally {
    drv.close()
  }
})

test('白名单外语言 → code_unsupported_language（不经 sandbox）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('invoke', { tool: 'shell', args: { mode: 'code', language: 'ruby', input: 'x' } })
    assert.equal(result.value.error.code, 'code_unsupported_language')
    assert.equal(drv.portCalls.length, 0)
  } finally {
    drv.close()
  }
})
