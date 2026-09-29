// `mcp-client` 服务协议级测试（node --test）：spawn `execute/main.ts` 直驱，
// 用最小 MCP 测试服务器（tools/fake-mcp-server.mjs）验真实传输 / 子进程生命周期。
// 覆盖：握手 / 控制 / EOF；list_tools（握手 + 换行分帧）；call_tool；close 终止子进程；
// 建连失败作数据；意外退出后重连并回灌 reconnected + 上行事件；drain 终止子进程。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FAKE = join(PKG_ROOT, 'tools', 'fake-mcp-server.mjs')
const FIXED_ENV = { run: 'test-run', thread: 't1', now: 0 }

function drive({ env } = {}) {
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT, env })
  return {
    ...drv,
    hello: () => drv.hello('mcp-client'),
    call: (method, args, callEnv = FIXED_ENV) => drv.call('mcp-client', method, args, callEnv),
  }
}

function configFor(mode, extra = [], overrides = {}) {
  return {
    server: 'srv',
    command: process.execPath,
    args: [FAKE, `--mode=${mode}`, ...extra],
    ...overrides,
  }
}

function markerPath(name) {
  const dir = join(tmpdir(), 'kilo')
  mkdirSync(dir, { recursive: true })
  return join(dir, `mcp-client-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
}

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await delay(30)
  }
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'mcp-client')
    assert.deepEqual(manifest.implements, ['mcp-client'])
    assert.deepEqual(manifest.methods['mcp-client'], ['list_tools', 'call_tool', 'close'])
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

test('args 形态非法 / call_tool 缺 tool → 协议 bad_args', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const nullArgs = await drv.request(
      'call',
      { port: 'mcp-client', method: 'list_tools', args: null, env: FIXED_ENV },
      'error',
    )
    assert.equal(nullArgs.code, 'bad_args')
    const noTool = await drv.call('call_tool', configFor('ok'))
    assert.equal(noTool.kind, 'error')
    assert.equal(noTool.code, 'bad_args')
  } finally {
    drv.close()
  }
})

test('缺 server / command → 结构化 bad_config（作数据，不抛）', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const noServer = await drv.call('list_tools', { command: process.execPath })
    assert.equal(noServer.kind, 'result')
    assert.equal(noServer.value.ok, false)
    assert.equal(noServer.value.error.code, 'bad_config')
    assert.equal(noServer.value.reconnected, null)
  } finally {
    drv.close()
  }
})

// ── list_tools：真实握手 + 换行分帧 ────────────────────────────────────────

test('list_tools：spawn + initialize 握手 + tools/list，回规范化工具条目', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('list_tools', configFor('ok'))
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, true)
    assert.equal(result.value.reconnected, null)
    assert.deepEqual(result.value.tools.map((tool) => tool.name).sort(), ['add', 'boom', 'echo'])
    const echo = result.value.tools.find((tool) => tool.name === 'echo')
    assert.equal(echo.description, '回显输入文本')
    assert.equal(echo.inputSchema.properties.message.type, 'string')
  } finally {
    drv.close()
  }
})

test('连接复用：同一 server 第二次 list_tools 复用子进程（listchanged 拉到新增工具）', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const first = await drv.call('list_tools', configFor('listchanged'))
    assert.deepEqual(
      first.value.tools.map((tool) => tool.name),
      ['echo'],
    )
    const second = await drv.call('list_tools', configFor('listchanged'))
    assert.deepEqual(second.value.tools.map((tool) => tool.name).sort(), ['echo', 'extra'])
  } finally {
    drv.close()
  }
})

// ── call_tool ──────────────────────────────────────────────────────────────

test('call_tool：转发 tools/call 并原样回结果', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const echo = await drv.call('call_tool', {
      ...configFor('ok'),
      tool: 'echo',
      arguments: { message: 'hi' },
    })
    assert.equal(echo.value.ok, true)
    assert.equal(echo.value.result.content[0].text, JSON.stringify({ message: 'hi' }))
    const add = await drv.call('call_tool', {
      ...configFor('ok'),
      tool: 'add',
      arguments: { a: 2, b: 3 },
    })
    assert.equal(add.value.result.content[0].text, '5')
  } finally {
    drv.close()
  }
})

// ── close / drain：终止子进程 ──────────────────────────────────────────────

test('close 终止该 server 子进程（marker 删除）', async () => {
  const marker = markerPath('close')
  const drv = drive()
  try {
    await drv.hello()
    await drv.call('list_tools', configFor('ok', [`--marker=${marker}`]))
    assert.equal(existsSync(marker), true)
    const closed = await drv.call('close', { server: 'srv' })
    assert.equal(closed.value.ok, true)
    assert.equal(closed.value.closed, 1)
    await waitFor(() => !existsSync(marker), 'child terminated on close')
    const again = await drv.call('close', { server: 'srv' })
    assert.equal(again.value.closed, 0)
  } finally {
    drv.close()
  }
})

test('drain 终止全部外部子进程', async () => {
  const marker = markerPath('drain')
  const drv = drive()
  try {
    await drv.hello()
    await drv.call('list_tools', configFor('ok', [`--marker=${marker}`]))
    assert.equal(existsSync(marker), true)
    assert.equal((await drv.request('drain', { deadline_ms: 1500 }, 'bye')).kind, 'bye')
    await waitFor(() => !existsSync(marker), 'child terminated on drain')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

// ── 失败作数据 / 意外退出重连 ──────────────────────────────────────────────

test('建连失败（服务器启动即退出）→ ok:false + mcp_connect_failed，不抛', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('list_tools', configFor('die'))
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'mcp_connect_failed')
  } finally {
    drv.close()
  }
})

test('子进程意外退出 → 重连并回灌 reconnected，上行 mcp-client.server exited 事件', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const first = await drv.call('list_tools', configFor('once'))
    assert.equal(first.value.ok, true)
    assert.equal(first.value.reconnected, null)
    // 服务器处理一次 tools/list 后退出；等其退出（事件 + 状态改写）
    await waitFor(
      () =>
        drv.events.some(
          (event) => event.topic === 'mcp-client.server' && event.payload.event === 'exited',
        ),
      'mcp-client.server exited event',
    )
    const second = await drv.call('list_tools', configFor('once'))
    assert.equal(second.value.ok, true)
    assert.equal(typeof second.value.reconnected, 'string')
    assert.ok(second.value.reconnected.length > 0)
  } finally {
    drv.close()
  }
})
