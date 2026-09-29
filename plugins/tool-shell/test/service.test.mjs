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

const DONE_POLL = {
  output: '',
  next_cursor: 0,
  running: false,
  exit_code: 0,
  code: null,
  truncated: false,
  dropped_bytes: 0,
  tail: '',
}

/** 假后端：按 sandbox 方法回形状正确的值；其余端口回密钥明文。 */
function defaultPort(port, method) {
  if (port === 'sandbox') {
    if (method === 'exec_start') return { value: { task_id: 'task-1' } }
    if (method === 'exec_poll') return { value: DONE_POLL }
    if (method === 'exec_kill') return { value: { killed: true } }
    if (method === 'session_close') return { value: { closed: true } }
  }
  return { value: 'plain-secret' }
}

function startService(options = {}) {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const portCalls = []
  const events = []
  let stderr = ''
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  const resolvePort = options.resolvePort ?? defaultPort

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
    assert.deepEqual(manifest.implements, ['tool-shell', 'tool-provider'])
    assert.deepEqual(manifest.methods['tool-shell'], ['describe', 'invoke'])
    assert.deepEqual(manifest.methods['tool-provider'], ['describe', 'invoke'])
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

test('invoke command 经反向 port.call 调 sandbox.exec_start（会话形态）并回 terminal 结果', async () => {
  const drv = startService({
    resolvePort: defaultPort,
  })
  try {
    await drv.hello()
    const result = await drv.call('invoke', baseBag())
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, true)
    assert.equal(result.value.result.kind, 'terminal')
    const startCall = drv.portCalls.find((call) => call.port === 'sandbox' && call.method === 'exec_start')
    assert.ok(startCall !== undefined, '应经反向 port.call 调 sandbox.exec_start')
    const isWindows = process.platform === 'win32'
    const expectedShell = isWindows ? ['pwsh', 'pwsh-preview', 'powershell.exe'] : ['bash', 'sh']
    assert.equal(startCall.args.session_id, 't1', '命令应走常驻会话（按线程隔离）')
    assert.equal(startCall.args.command, 'echo hi')
    assert.ok(expectedShell.includes(startCall.args.session_shell.cmd), `shell=${startCall.args.session_shell.cmd}`)
    assert.equal(startCall.args.session_shell.syntax, isWindows ? 'powershell' : 'posix')
    assert.equal(startCall.args.tier, 'severe')
    assert.ok(
      drv.portCalls.some((call) => call.port === 'sandbox' && call.method === 'exec_poll'),
      '应轮询 exec_poll',
    )
  } finally {
    drv.close()
  }
})

test('invoke code 经服务协议回 json 结构化结果', async () => {
  const drv = startService({
    resolvePort: (port, method) => {
      if (method === 'exec_start') return { value: { task_id: 'task-1' } }
      if (method === 'exec_poll') return { value: { ...DONE_POLL, output: '{"n":2}', next_cursor: 7 } }
      return { value: null }
    },
  })
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

test('invoke 的 auth_ref 经 secrets.resolve；明文只出现在 exec_start env，不进结果', async () => {
  const secret = 'svc-secret'
  const drv = startService({
    resolvePort: (port, method) => {
      if (port === 'secrets' && method === 'resolve') return { value: secret }
      return defaultPort(port, method)
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('invoke', baseBag({ auth_ref: { kind: 'local', name: 'TOKEN' } }))
    const secretsCall = drv.portCalls.find((call) => call.port === 'secrets')
    assert.ok(secretsCall !== undefined, '应经反向 port.call 调 secrets.resolve')
    assert.deepEqual(secretsCall.args.auth_ref, { kind: 'local', name: 'TOKEN' })
    const startCall = drv.portCalls.find((call) => call.port === 'sandbox' && call.method === 'exec_start')
    assert.deepEqual(startCall.args.env, { TOKEN: secret })
    assert.equal(JSON.stringify(result.value).includes(secret), false, '明文不得进结果')
    assert.equal(drv.events.length, 0, '无 call_id 时不发 event')
    assert.equal(drv.stderrText().includes(secret), false, '明文不得进日志')
  } finally {
    drv.close()
  }
})

test('sandbox 前置失败原码透传', async () => {
  const drv = startService({
    resolvePort: (port, method) =>
      method === 'exec_start' ? { error: 'fs_denied', message: 'outside' } : { value: 'x' },
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
