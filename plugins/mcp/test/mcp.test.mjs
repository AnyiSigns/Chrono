// `mcp` 服务协议级测试（node --test）：自实现最小协议驱动 + 最小 MCP 测试服务器。
// 驱动 spawn `node execute/main.ts`，发 hello → 收 manifest，发 call → 收 result / error，收集 event。
// 覆盖：握手 / 控制 / 未知方法 / EOF 自退出；清单出世界（read / write 往返、discover 只写自有存储、
// 不产世界写计划）；confirmed=false 不 spawn；四要素兜底与 render；invoke 路由与结构化错误；
// 退出重连；list_changed 下一拍重拉；drain 终止子进程；④ 追加日志重放。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FAKE = join(HERE, 'fake-mcp-server.mjs')
const MARKER_DIR = join(tmpdir(), 'kilo')

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

function startService(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) }
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const secretsResolver =
    options.secretsResolver ??
    (() => ({ error: 'secret_missing', message: 'no resolver' }))
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        const outcome = secretsResolver(message.method, message.args)
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
    exit,
    events,
    portCalls,
    request,
    hello: () => request('hello', { impl: 'mcp', gen: 'gen-1' }, 'manifest'),
    call: (method, args) =>
      request(
        'call',
        { port: 'mcp', method, args, env: { run: 'test-run', thread: 't1', now: 0 } },
        ['result', 'error'],
      ),
    close: () => child.stdin.end(),
  }
}

function serverEntry(id, mode, extra = {}, extraArgs = []) {
  return {
    id,
    command: process.execPath,
    args: [FAKE, `--mode=${mode}`, ...extraArgs],
    confirmed: true,
    ...extra,
  }
}

function bodyOf(servers, tools = []) {
  return { version: 1, servers, tools }
}

/** 先把清单写进 owner 自有存储（出世界），再 discover 读取它。 */
async function seed(drv, servers, tools = []) {
  const result = await drv.call('write', { body: bodyOf(servers, tools) })
  assert.equal(result.kind, 'result')
  assert.equal(result.value.ok, true)
}

/** 读回整份清单（owner 自有存储）。 */
async function readBody(drv) {
  const result = await drv.call('read', {})
  assert.equal(result.kind, 'result')
  return result.value
}

/** discover 结果里唯一一条 extern 指令的载荷。 */
function externOf(result) {
  assert.equal(result.kind, 'result')
  assert.equal(result.value.$directives.length, 1)
  assert.equal(result.value.$directives[0].kind, 'extern')
  return result.value.$directives[0].payload
}

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await delay(30)
  }
}

function markerPath(name) {
  mkdirSync(MARKER_DIR, { recursive: true })
  return join(MARKER_DIR, `mcp-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
}

// ── 握手 / 控制 / 未知方法 ──────────────────────────────────────────────────

test('hello 回 manifest（与 plugin.json 一致）；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'mcp')
    assert.deepEqual(manifest.implements, ['mcp'])
    assert.deepEqual(manifest.methods.mcp, ['describe', 'invoke', 'discover', 'read', 'write'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'durable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('命令声明只读标记：ping / tools_list 只读，tools_call 非只读', () => {
  const decl = JSON.parse(readFileSync(join(PKG_ROOT, 'plugin.json'), 'utf8'))
  const readonly = Object.fromEntries(decl.commands.map((command) => [command.name, command.readonly]))
  assert.equal(readonly['mcp.in.ping'], true)
  assert.equal(readonly['mcp.in.tools_list'], true)
  assert.equal(readonly['mcp.in.tools_call'], undefined)
})

test('未知方法 / 未知能力类 → 结构化 error', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const unknownMethod = await drv.request('call', { port: 'mcp', method: 'nope', args: {} }, 'error')
    assert.equal(unknownMethod.code, 'unknown_method')
    const unknownCap = await drv.request('call', { port: 'other', method: 'describe', args: {} }, 'error')
    assert.equal(unknownCap.code, 'unresolved_cap')
  } finally {
    drv.close()
  }
})

test('describe 只回本插件自述，不回外部工具清单', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const described = await drv.call('describe', {})
    assert.equal(described.kind, 'result')
    assert.deepEqual(described.value.tools, [])
    assert.equal(described.value.adapter.identity, 'mcp')
    assert.equal(described.value.adapter.tool_source, 'service:mcp.read')
    assert.deepEqual(described.value.adapter.inbound_v1.commands, [
      'mcp.in.ping',
      'mcp.in.tools_list',
      'mcp.in.tools_call',
    ])
  } finally {
    drv.close()
  }
})

// ── read / write：清单出世界的往返 ────────────────────────────────────────

test('read 空存储 → 空清单；write 后 read 往返一致', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.deepEqual(await readBody(drv), { version: 1, servers: [], tools: [] })
    const entry = serverEntry('srv', 'ok')
    await seed(drv, [entry])
    const body = await readBody(drv)
    assert.equal(body.version, 1)
    assert.equal(body.servers.length, 1)
    assert.equal(body.servers[0].id, 'srv')
    // 同内容重复写幂等短路。
    const again = await drv.call('write', { body: bodyOf([entry]) })
    assert.equal(again.value.changed, false)
  } finally {
    drv.close()
  }
})

test('write 形态非法 → bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const bad = await drv.call('write', { body: { version: 1, servers: [] } })
    assert.equal(bad.kind, 'error')
    assert.equal(bad.code, 'bad_args')
  } finally {
    drv.close()
  }
})

// ── discover：写自有存储、不产世界写计划 ───────────────────────────────────

test('discover 空清单 → 只回 extern，无写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('discover', {})
    const payload = externOf(result)
    assert.equal(payload.changed, false)
    assert.equal(payload.tools, 0)
  } finally {
    drv.close()
  }
})

test('discover 含 confirmed 服务器 → 写自有存储、命名空间化、四要素与 render、无世界写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'ok')])
    const result = await drv.call('discover', {})
    const payload = externOf(result)
    assert.equal(payload.changed, true)
    assert.equal(payload.tools, 3)

    const body = await readBody(drv)
    assert.equal(body.version, 1)
    assert.deepEqual(
      body.tools.map((tool) => tool.name).sort(),
      ['mcp.srv.add', 'mcp.srv.boom', 'mcp.srv.echo'],
    )
    const echo = body.tools.find((tool) => tool.name === 'mcp.srv.echo')
    assert.equal(echo.server, 'srv')
    assert.equal(echo.tool, 'echo')
    for (const key of ['intent', 'when_to_use', 'param_semantics', 'boundaries', 'description']) {
      assert.ok(echo[key] !== undefined && echo[key] !== null && echo[key] !== '', key)
    }
    assert.equal(echo.param_semantics.message, '要回显的文本')
    assert.equal(echo.boundaries, '由外部 MCP 服务器定义')
    assert.equal(echo.argsSchema.properties.message.type, 'string')
    assert.equal(echo.idempotent, false)
    assert.deepEqual(echo.render, {
      form: 'card',
      label: 'mcp.srv.echo',
      summary: '{tool}',
      tone: 'ghost',
      detail: { kind: 'json' },
      live: false,
    })
    // 易变运行态不写回清单：只保留配置（含 confirmed）
    assert.equal(body.servers[0].connected, undefined)
    assert.equal(body.servers[0].tool_count, undefined)
    assert.equal(body.servers[0].failures, undefined)
    assert.equal(body.servers[0].confirmed, true)
    assert.ok(drv.events.some((event) => event.topic === 'mcp.server' && event.payload.event === 'discovered'))

    const described = await drv.call('describe', {})
    assert.deepEqual(described.value.tools, [])
  } finally {
    drv.close()
  }
})

test('四要素兜底：MCP 无 description 时用中性文案；inputSchema 参数无描述时用「参数 <名>」', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'minimal')])
    await drv.call('discover', {})
    const body = await readBody(drv)
    const bare = body.tools[0]
    assert.equal(bare.name, 'mcp.srv.bare')
    assert.equal(bare.intent, '调用外部 MCP 工具 bare')
    assert.equal(bare.when_to_use, '需要外部 MCP 服务器 srv 的 bare 能力时')
    assert.equal(bare.param_semantics.x, '参数 x')
    assert.equal(bare.boundaries, '由外部 MCP 服务器定义')
  } finally {
    drv.close()
  }
})

test('render detail.kind：image 标注映射为 image', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'image')])
    await drv.call('discover', {})
    const body = await readBody(drv)
    const echo = body.tools.find((tool) => tool.tool === 'echo')
    assert.equal(echo.render.detail.kind, 'image')
  } finally {
    drv.close()
  }
})

test('confirmed=false → 不 spawn、条目只登记', async () => {
  const marker = markerPath('unconfirmed')
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'ok', { confirmed: false }, [`--marker=${marker}`])])
    const result = await drv.call('discover', {})
    const payload = externOf(result)
    assert.equal(payload.tools, 0)
    assert.equal(existsSync(marker), false)
    const invoked = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: {} })
    assert.equal(invoked.value.error.code, 'mcp_server_unconfirmed')
  } finally {
    drv.close()
  }
})

test('同一状态重复 discover 不写回（易变运行态不写清单）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'ok')])
    assert.equal(externOf(await drv.call('discover', {})).changed, true)
    assert.equal(externOf(await drv.call('discover', {})).changed, false)
  } finally {
    drv.close()
  }
})

test('env.auth_ref 经 secrets.resolve 解析后注入子进程 env；明文不进存储', async () => {
  const envMarker = markerPath('authref-env')
  const drv = startService({
    secretsResolver: (method, args) => {
      assert.equal(method, 'resolve')
      assert.deepEqual(args.auth_ref, { kind: 'local', name: 'TOKEN' })
      return { value: 'secret-value-123' }
    },
  })
  try {
    await drv.hello()
    const entry = serverEntry(
      'srv',
      'ok',
      { env: { ECHO_TOKEN: { auth_ref: { kind: 'local', name: 'TOKEN' } } } },
      [`--env-marker=${envMarker}`],
    )
    await seed(drv, [entry])
    const result = await drv.call('discover', {})
    assert.equal(externOf(result).tools, 3)
    const secretsCall = drv.portCalls.find((call) => call.port === 'secrets' && call.method === 'resolve')
    assert.ok(secretsCall !== undefined, '应经反向 port.call 调 secrets.resolve')
    assert.equal(secretsCall.call_id, result.id, '反向帧回带发起 call 帧 id')
    const stored = JSON.stringify(await readBody(drv))
    assert.equal(stored.includes('secret-value-123'), false, '明文不得进存储 / 返回值')
    assert.equal(readFileSync(envMarker, 'utf8'), 'secret-value-123')
  } finally {
    drv.close()
  }
})

test('env.auth_ref 解析失败 → 计入连接失败，不 spawn', async () => {
  const drv = startService({
    secretsResolver: () => ({ error: 'secret_missing', message: 'not found' }),
  })
  try {
    await drv.hello()
    const entry = serverEntry(
      'srv',
      'ok',
      { env: { ECHO_TOKEN: { auth_ref: { kind: 'local', name: 'TOKEN' } } } },
    )
    await seed(drv, [entry])
    const payload = externOf(await drv.call('discover', {}))
    assert.equal(payload.tools, 0)
    assert.ok(
      drv.events.some((event) => event.topic === 'mcp.server' && event.payload.event === 'connect_failed'),
    )
    const invoked = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: {} })
    assert.equal(invoked.value.error.code, 'mcp_tool_unknown')
  } finally {
    drv.close()
  }
})

// ── invoke：路由与结构化错误 ───────────────────────────────────────────────

test('invoke 路由到子进程 tools/call；未知 / 未确认 / 形态非法 → 结构化错误', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'ok')])
    await drv.call('discover', {})

    const echo = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: { message: 'hi' } })
    assert.equal(echo.value.ok, true)
    assert.equal(echo.value.result.content[0].text, JSON.stringify({ message: 'hi' }))
    const add = await drv.call('invoke', { tool: 'mcp.srv.add', tool_args: { a: 2, b: 3 } })
    assert.equal(add.value.result.content[0].text, '5')

    const unknownServer = await drv.call('invoke', { tool: 'mcp.nope.echo', tool_args: {} })
    assert.equal(unknownServer.value.ok, false)
    assert.equal(unknownServer.value.error.code, 'mcp_server_unknown')
    const unknownTool = await drv.call('invoke', { tool: 'mcp.srv.nope', tool_args: {} })
    assert.equal(unknownTool.value.error.code, 'mcp_tool_unknown')
    const badRef = await drv.call('invoke', { tool: 'nope', tool_args: {} })
    assert.equal(badRef.value.error.code, 'bad_tool_ref')

    const badArgs = await drv.call('invoke', {})
    assert.equal(badArgs.kind, 'error')
    assert.equal(badArgs.code, 'bad_args')

    await seed(drv, [serverEntry('srv', 'ok', { confirmed: false })])
    await drv.call('discover', {})
    const unconfirmed = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: {} })
    assert.equal(unconfirmed.value.error.code, 'mcp_server_unconfirmed')
  } finally {
    drv.close()
  }
})

// ── 子进程退出：重连 / 隔离阈值 ────────────────────────────────────────────

test('子进程退出 → 下一拍 discover 重连重拉', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'once')])
    await drv.call('discover', {})
    assert.equal((await readBody(drv)).tools.length, 3)

    await waitFor(
      () => drv.events.some((event) => event.topic === 'mcp.server' && event.payload.event === 'exited'),
      'server exited event',
    )

    // 重连重拉成功：工具清单不变 → 清单无变化，不写回（changed=false）
    const payload = externOf(await drv.call('discover', {}))
    assert.equal(payload.tools, 3)
    assert.equal(payload.changed, false)

    const echo = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: { message: 'x' } })
    assert.equal(echo.value.ok, true)
  } finally {
    drv.close()
  }
})

test('连续失败超限 → 隔离该条目（工具摘除、invoke 回结构化错误）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'die')])
    let last = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = externOf(await drv.call('discover', {}))
    }
    assert.equal(last.isolated, 1)

    const isolated = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: {} })
    assert.equal(isolated.value.ok, false)
    assert.equal(isolated.value.error.code, 'mcp_server_isolated')

    // 隔离状态留内存：后续 discover 仍隔离（不再 spawn）
    assert.equal(externOf(await drv.call('discover', {})).isolated, 1)
  } finally {
    drv.close()
  }
})

// ── tools/list_changed：下一拍重拉 ─────────────────────────────────────────

test('tools/list_changed：下一拍 discover 重拉；清单未变则不写回', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'dirty_once')])
    await drv.call('discover', {})
    assert.equal((await readBody(drv)).tools.length, 3)

    await delay(200)
    assert.equal(externOf(await drv.call('discover', {})).changed, false)
  } finally {
    drv.close()
  }
})

test('listchanged：下一次 discover 拉到新工具清单', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'listchanged')])
    await drv.call('discover', {})
    assert.deepEqual(
      (await readBody(drv)).tools.map((tool) => tool.name),
      ['mcp.srv.echo'],
    )
    await delay(200)
    await drv.call('discover', {})
    assert.deepEqual(
      (await readBody(drv)).tools.map((tool) => tool.name).sort(),
      ['mcp.srv.echo', 'mcp.srv.extra'],
    )
  } finally {
    drv.close()
  }
})

// ── ④ 追加日志重放 ────────────────────────────────────────────────────────

test('④ 追加日志：新进程重放读回上次写入的清单', async () => {
  const dir = join(tmpdir(), 'kilo', `mcp-store-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const first = startService({ env: { CHRONO_PLUGIN_DATA: dir } })
  try {
    await first.hello()
    await seed(first, [serverEntry('srv', 'ok')])
    await first.call('discover', {})
    assert.equal((await readBody(first)).tools.length, 3)
  } finally {
    first.close()
  }
  await first.exit

  const second = startService({ env: { CHRONO_PLUGIN_DATA: dir } })
  try {
    await second.hello()
    const body = await readBody(second)
    assert.equal(body.servers[0].id, 'srv')
    assert.equal(body.tools.length, 3)
  } finally {
    second.close()
  }
  await second.exit
})

// ── drain 终止全部子进程 ───────────────────────────────────────────────────

test('drain 终止全部外部子进程', async () => {
  const marker = markerPath('drain')
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', 'ok', {}, [`--marker=${marker}`])])
    await drv.call('discover', {})
    assert.equal(existsSync(marker), true)

    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
    await waitFor(() => !existsSync(marker), 'external child terminated')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})
