// `mcp` 服务协议级测试（node --test）：spawn `execute/main.ts`，把反向调用（secrets / mcp-client）
// 桥接到内存假后端。连接与子进程生命周期已归 `mcp-client`，本套只验本插件的清单存储与
// 失败 / 隔离 / 重启策略：握手 / 控制 / EOF；清单出世界（read / write 往返、discover 写自有存储、
// 不产世界写计划）；confirmed=false 不连；四要素兜底与 render；invoke 路由与结构化错误；
// 连接提供方回灌 reconnected → 记账 / 隔离；配置变化复位；④ 追加日志重放。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'test-run', thread: 't1', now: 0 }

const ECHO = {
  name: 'echo',
  description: '回显输入文本',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: '要回显的文本' } },
    required: ['message'],
  },
}
const ADD = {
  name: 'add',
  description: '两数相加',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'number', description: '加数 a' },
      b: { type: 'number', description: '加数 b' },
    },
    required: ['a', 'b'],
  },
}
const BOOM = {
  name: 'boom',
  description: '总是失败的示例工具',
  inputSchema: { type: 'object', properties: {} },
}
const OK_TOOLS = [ECHO, ADD, BOOM]
const BARE = {
  name: 'bare',
  inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
}
const IMAGE_ECHO = {
  ...ECHO,
  annotations: { content_type: 'image/png' },
  outputSchema: { type: 'object', format: 'image' },
}

/** 假 `mcp-client`：list_tools / call_tool / close 的默认应答（可被单个用例覆盖）。 */
function defaultClient() {
  return (method, args) => {
    if (method === 'list_tools') return { value: { ok: true, tools: OK_TOOLS, reconnected: null } }
    if (method === 'call_tool') {
      const tool = args.tool
      if (tool === 'add') {
        const sum = Number(args.arguments?.a ?? 0) + Number(args.arguments?.b ?? 0)
        return {
          value: {
            ok: true,
            result: { content: [{ type: 'text', text: String(sum) }] },
            reconnected: null,
          },
        }
      }
      return {
        value: {
          ok: true,
          result: { content: [{ type: 'text', text: JSON.stringify(args.arguments ?? {}) }] },
          reconnected: null,
        },
      }
    }
    if (method === 'close') return { value: { ok: true, closed: 1 } }
    return { error: 'unknown_method', message: 'no' }
  }
}

/** SDK 驱动适配：能力类固定，反向调用（secrets / mcp-client）桥接同步应答。 */
function drive({ onClient, secretsResolver, env } = {}) {
  const client = onClient ?? defaultClient()
  const secrets = secretsResolver ?? (() => ({ error: 'secret_missing', message: 'no resolver' }))
  const drv = startService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    env,
    onPortCall: (message) => {
      if (message.port === 'secrets') {
        const outcome = secrets(message.method, message.args)
        return outcome.error
          ? { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
          : { ok: true, value: outcome.value }
      }
      if (message.port === 'mcp-client') {
        const outcome = client(message.method, message.args)
        return outcome.error
          ? { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
          : { ok: true, value: outcome.value }
      }
      return { ok: false, code: 'unresolved_cap', message: `no bridge for ${message.port}` }
    },
  })
  return {
    ...drv,
    hello: () => drv.hello('mcp'),
    call: (method, args, callEnv = FIXED_ENV) => drv.call('mcp', method, args, callEnv),
    clientCalls: (method) =>
      drv.portCalls.filter(
        (frame) => frame.port === 'mcp-client' && (method === undefined || frame.method === method),
      ),
    secretCalls: () => drv.portCalls.filter((frame) => frame.port === 'secrets'),
  }
}

function serverEntry(id, extra = {}) {
  return {
    id,
    command: process.execPath,
    args: ['--fake'],
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

function markerDataDir(name) {
  const dir = join(
    tmpdir(),
    'kilo',
    `mcp-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

// ── 握手 / 控制 / 未知方法 ──────────────────────────────────────────────────

test('hello 回 manifest（与 plugin.json 一致）；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
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
  const readonly = Object.fromEntries(
    decl.commands.map((command) => [command.name, command.readonly]),
  )
  assert.equal(readonly['mcp.in.ping'], true)
  assert.equal(readonly['mcp.in.tools_list'], true)
  assert.equal(readonly['mcp.in.tools_call'], undefined)
})

test('未知方法 / 未知能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const unknownMethod = await drv.request(
      'call',
      { port: 'mcp', method: 'nope', args: {} },
      'error',
    )
    assert.equal(unknownMethod.code, 'unknown_method')
    const unknownCap = await drv.request(
      'call',
      { port: 'other', method: 'describe', args: {} },
      'error',
    )
    assert.equal(unknownCap.code, 'unresolved_cap')
  } finally {
    drv.close()
  }
})

test('describe 只回本插件自述，不回外部工具清单', async () => {
  const drv = drive()
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
  const drv = drive()
  try {
    await drv.hello()
    assert.deepEqual(await readBody(drv), { version: 1, servers: [], tools: [] })
    const entry = serverEntry('srv')
    await seed(drv, [entry])
    const body = await readBody(drv)
    assert.equal(body.version, 1)
    assert.equal(body.servers.length, 1)
    assert.equal(body.servers[0].id, 'srv')
    const again = await drv.call('write', { body: bodyOf([entry]) })
    assert.equal(again.value.changed, false)
  } finally {
    drv.close()
  }
})

test('write 形态非法 → bad_args', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const bad = await drv.call('write', { body: { version: 1, servers: [] } })
    assert.equal(bad.kind, 'error')
    assert.equal(bad.code, 'bad_args')
  } finally {
    drv.close()
  }
})

// ── discover：写自有存储、经 mcp-client 委托、不产世界写计划 ────────────────

test('discover 空清单 → 只回 extern，无写计划，且不调 mcp-client', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('discover', {})
    const payload = externOf(result)
    assert.equal(payload.changed, false)
    assert.equal(payload.tools, 0)
    assert.equal(drv.clientCalls().length, 0)
  } finally {
    drv.close()
  }
})

test('discover 含 confirmed 服务器 → 委派 mcp-client、写自有存储、命名空间化、四要素与 render、无世界写计划', async () => {
  const drv = drive()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv')])
    const result = await drv.call('discover', {})
    const payload = externOf(result)
    assert.equal(payload.changed, true)
    assert.equal(payload.tools, 3)

    // 委派给 mcp-client：list_tools 收到 server + 已解析 env（无 auth_ref 时为空对象）
    const listCall = drv.clientCalls('list_tools')[0]
    assert.equal(listCall.args.server, 'srv')
    assert.equal(listCall.args.command, process.execPath)
    assert.deepEqual(listCall.args.args, ['--fake'])
    assert.deepEqual(listCall.args.env, {})

    const body = await readBody(drv)
    assert.equal(body.version, 1)
    assert.deepEqual(body.tools.map((tool) => tool.name).sort(), [
      'mcp.srv.add',
      'mcp.srv.boom',
      'mcp.srv.echo',
    ])
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
    assert.equal(body.servers[0].connected, undefined)
    assert.equal(body.servers[0].tool_count, undefined)
    assert.equal(body.servers[0].failures, undefined)
    assert.equal(body.servers[0].confirmed, true)
    assert.ok(
      drv.events.some(
        (event) => event.topic === 'mcp.server' && event.payload.event === 'discovered',
      ),
    )

    const described = await drv.call('describe', {})
    assert.deepEqual(described.value.tools, [])
  } finally {
    drv.close()
  }
})

test('四要素兜底：MCP 无 description 时用中性文案；inputSchema 参数无描述时用「参数 <名>」', async () => {
  const drv = drive({ onClient: () => ({ value: { ok: true, tools: [BARE], reconnected: null } }) })
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv')])
    await drv.call('discover', {})
    const bare = (await readBody(drv)).tools[0]
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
  const drv = drive({
    onClient: () => ({ value: { ok: true, tools: [IMAGE_ECHO], reconnected: null } }),
  })
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv')])
    await drv.call('discover', {})
    const echo = (await readBody(drv)).tools.find((tool) => tool.tool === 'echo')
    assert.equal(echo.render.detail.kind, 'image')
  } finally {
    drv.close()
  }
})

test('confirmed=false → 不调 mcp-client.list_tools、只登记；invoke 回 unconfirmed', async () => {
  const drv = drive()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', { confirmed: false })])
    const payload = externOf(await drv.call('discover', {}))
    assert.equal(payload.tools, 0)
    assert.equal(drv.clientCalls('list_tools').length, 0)
    assert.ok(drv.clientCalls('close').length >= 1, '应通知 mcp-client 关闭该连接')
    const invoked = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: {} })
    assert.equal(invoked.value.error.code, 'mcp_server_unconfirmed')
  } finally {
    drv.close()
  }
})

test('同一状态重复 discover 不写回（易变运行态不写清单）', async () => {
  const drv = drive()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv')])
    assert.equal(externOf(await drv.call('discover', {})).changed, true)
    assert.equal(externOf(await drv.call('discover', {})).changed, false)
  } finally {
    drv.close()
  }
})

test('env.auth_ref 经 secrets.resolve 解析后随 mcp-client 调用下传；明文不进存储；解析结果按配置缓存', async () => {
  const drv = drive({
    secretsResolver: (method, args) => {
      assert.equal(method, 'resolve')
      assert.deepEqual(args.auth_ref, { kind: 'local', name: 'TOKEN' })
      return { value: 'secret-value-123' }
    },
  })
  try {
    await drv.hello()
    await seed(drv, [
      serverEntry('srv', { env: { ECHO_TOKEN: { auth_ref: { kind: 'local', name: 'TOKEN' } } } }),
    ])
    const result = await drv.call('discover', {})
    assert.equal(externOf(result).tools, 3)
    assert.ok(drv.secretCalls().length === 1, '应经反向 port.call 调 secrets.resolve')
    const listCall = drv.clientCalls('list_tools')[0]
    assert.equal(listCall.args.env.ECHO_TOKEN, 'secret-value-123', '已解析明文随连接配置下传')
    const stored = JSON.stringify(await readBody(drv))
    assert.equal(stored.includes('secret-value-123'), false, '明文不得进存储 / 返回值')
    // 第二次 discover 复用已缓存 env：不再调 secrets.resolve
    await drv.call('discover', {})
    assert.equal(drv.secretCalls().length, 1)
  } finally {
    drv.close()
  }
})

test('env.auth_ref 解析失败 → 计入连接失败，不调 mcp-client', async () => {
  const drv = drive({ secretsResolver: () => ({ error: 'secret_missing', message: 'not found' }) })
  try {
    await drv.hello()
    await seed(drv, [
      serverEntry('srv', { env: { ECHO_TOKEN: { auth_ref: { kind: 'local', name: 'TOKEN' } } } }),
    ])
    const payload = externOf(await drv.call('discover', {}))
    assert.equal(payload.tools, 0)
    assert.equal(drv.clientCalls('list_tools').length, 0)
    assert.ok(
      drv.events.some(
        (event) => event.topic === 'mcp.server' && event.payload.event === 'connect_failed',
      ),
    )
    const invoked = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: {} })
    assert.equal(invoked.value.error.code, 'mcp_tool_unknown')
  } finally {
    drv.close()
  }
})

// ── invoke：路由与结构化错误 ───────────────────────────────────────────────

test('invoke 委派 mcp-client.call_tool；未知 / 未确认 / 形态非法 → 结构化错误', async () => {
  const drv = drive()
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv')])
    await drv.call('discover', {})

    const echo = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: { message: 'hi' } })
    assert.equal(echo.value.ok, true)
    assert.equal(echo.value.result.content[0].text, JSON.stringify({ message: 'hi' }))
    const callCall = drv.clientCalls('call_tool')[0]
    assert.equal(callCall.args.tool, 'echo')
    assert.deepEqual(callCall.args.arguments, { message: 'hi' })
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
  } finally {
    drv.close()
  }
})

// ── 失败 / 隔离 / 重启策略（消费 mcp-client 回灌） ──────────────────────────

test('mcp-client 回灌 reconnected → 记一次退出失败并发 exited 事件，随后重拉成功复位', async () => {
  let calls = 0
  const drv = drive({
    onClient: (method) => {
      if (method === 'list_tools') {
        calls += 1
        return {
          value: { ok: true, tools: OK_TOOLS, reconnected: calls === 1 ? null : 'exit(0)' },
        }
      }
      return { value: { ok: true, closed: 1 } }
    },
  })
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv')])
    assert.equal(externOf(await drv.call('discover', {})).changed, true)
    // 第二拍：连接提供方报上一连接意外退出；工具清单不变 → 不写回，但记 exited 事件
    const payload = externOf(await drv.call('discover', {}))
    assert.equal(payload.tools, 3)
    assert.equal(payload.changed, false)
    assert.ok(
      drv.events.some((event) => event.topic === 'mcp.server' && event.payload.event === 'exited'),
    )
  } finally {
    drv.close()
  }
})

test('连续失败超限 → 隔离该条目（工具摘除、invoke 回结构化错误）', async () => {
  const drv = drive({
    onClient: (method) => {
      if (method === 'list_tools')
        return {
          value: {
            ok: false,
            error: { code: 'mcp_connect_failed', message: 'die' },
            reconnected: null,
          },
        }
      return { value: { ok: true, closed: 1 } }
    },
  })
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv')])
    let last = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = externOf(await drv.call('discover', {}))
    }
    assert.equal(last.isolated, 1)

    const isolated = await drv.call('invoke', { tool: 'mcp.srv.echo', tool_args: {} })
    assert.equal(isolated.value.ok, false)
    assert.equal(isolated.value.error.code, 'mcp_server_isolated')

    assert.equal(externOf(await drv.call('discover', {})).isolated, 1)
    assert.ok(
      drv.events.some(
        (event) => event.topic === 'mcp.server' && event.payload.event === 'isolated',
      ),
      '应上行 isolated 事件',
    )
  } finally {
    drv.close()
  }
})

test('连接配置变化 → 复位隔离与失败计数（给修好的配置一次重试机会）', async () => {
  const seen = []
  const drv = drive({
    onClient: (method, args) => {
      if (method === 'list_tools') {
        seen.push(args.args[0])
        if (args.args[0] === '--fixed')
          return { value: { ok: true, tools: OK_TOOLS, reconnected: null } }
        return {
          value: {
            ok: false,
            error: { code: 'mcp_connect_failed', message: 'die' },
            reconnected: null,
          },
        }
      }
      return { value: { ok: true, closed: 1 } }
    },
  })
  try {
    await drv.hello()
    await seed(drv, [serverEntry('srv', { args: ['--bad'] })])
    for (let attempt = 0; attempt < 3; attempt += 1) await drv.call('discover', {})
    assert.equal(externOf(await drv.call('discover', {})).isolated, 1)

    await seed(drv, [serverEntry('srv', { args: ['--fixed'] })])
    const payload = externOf(await drv.call('discover', {}))
    assert.equal(payload.isolated, 0)
    assert.equal(payload.tools, 3)
    assert.ok(seen.includes('--fixed'))
  } finally {
    drv.close()
  }
})

// ── ④ 追加日志重放 ────────────────────────────────────────────────────────

test('④ 追加日志：新进程重放读回上次写入的清单', async () => {
  const dir = markerDataDir('store')
  const first = drive({ env: { CHRONO_PLUGIN_DATA: dir } })
  try {
    await first.hello()
    await seed(first, [serverEntry('srv')])
    await first.call('discover', {})
    assert.equal((await readBody(first)).tools.length, 3)
  } finally {
    first.close()
  }
  await first.exit
  assert.equal(existsSync(join(dir, 'mcp.jsonl')), true)

  const second = drive({ env: { CHRONO_PLUGIN_DATA: dir } })
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

// ── drain / EOF ────────────────────────────────────────────────────────────

test('drain 收口 bye 后自退出', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})
