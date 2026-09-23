// 服务层测试（node --test）：投影装配纯函数、各命令的服务装配与反向调用 args、
// per-thread 槽键控、软删 / 恢复计划上提、错误收口、帧 / 路由 / 端口 / 静态 / 入站桥，
// 以及服务协议级（hello → manifest / ping / probe / drain → bye / EOF 自退出）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  assembleBranchArgs,
  assembleRevealArgs,
  assembleSessionArgs,
  assembleWorkspaceListArgs,
  assembleWorkspaceWriteArgs,
  createHandlers,
  identityBody,
  identityRefs,
  slotOf,
  threadKeyOf,
} from '../execute/methods.js'
import { createFrameDecoder, encodeFrame } from '../execute/frames.js'
import { commandFrame, extractValue, interpretResponse, submitFrame, unwrapPlan } from '../execute/bridge.js'
import { DEFAULT_SIDEBAR_PORT, parsePort, resolvePort } from '../execute/port.js'
import { routeOf } from '../execute/routes.js'
import { readWebFile, WEB_FILE_RE } from '../execute/static.js'
import { BadArgsError } from '../execute/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.js')
const WEB = join(PKG_ROOT, 'execute', 'web')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-sidebar-${label}-`))
}

/** 记录型假反向调用端口：每次调用入 calls，回给定 outcome。 */
function recordingPort(outcome) {
  const calls = []
  return {
    calls,
    call: async (port, method, args) => {
      calls.push({ port, method, args })
      return outcome
    },
  }
}

function sessionPlan(payload) {
  return { $directives: [{ kind: 'write', request: { op: 'batch', args: { ops: [] } } }, { kind: 'extern', payload }] }
}

function idsFixture() {
  return {
    session: {
      body: {
        version: 1,
        current: 'c1',
        conversations: [{ id: 'c1', workspace_id: 'w1', title: 'A1', head: { def: 'h1' }, count: 1 }],
      },
      refs: { h1: { id: 'm1', role: 'user', content: 'hi', prev: null } },
    },
    input: {
      body: {
        slots: {
          _main: { kind: 'session.new', workspace_id: 'w1' },
          t1: { kind: 'session.select', conversation: 'c1' },
        },
      },
    },
    workspace: { body: { version: 1, workspaces: [{ id: 'w1', name: 'A', path: '/a' }] } },
  }
}

// ---- 装配纯函数 ----

test('投影取用：identityBody / identityRefs / slotOf / threadKeyOf', () => {
  const ids = idsFixture()
  assert.deepEqual(identityBody(ids, 'workspace'), ids.workspace.body)
  assert.deepEqual(identityRefs(ids, 'session'), ids.session.refs)
  assert.deepEqual(identityRefs(ids, 'missing'), {})
  assert.equal(identityBody(ids, 'missing'), null)
  assert.deepEqual(slotOf(ids.input.body, '_main'), { kind: 'session.new', workspace_id: 'w1' })
  assert.equal(slotOf({}, '_main'), null)
  assert.equal(threadKeyOf({ thread: 't1' }), 't1')
  assert.equal(threadKeyOf({ thread: null }), '_main')
  assert.equal(threadKeyOf(null), '_main')
})

test('会话装配：{session, slots, thread_id, slot}；缺身份即失败码', () => {
  const ids = idsFixture()
  const assembled = assembleSessionArgs(ids, { thread: null })
  assert.equal(assembled.ok, true)
  assert.deepEqual(assembled.args, {
    session: ids.session.body,
    slots: ids.input.body,
    thread_id: '_main',
    slot: ids.input.body.slots._main,
  })
  const threaded = assembleSessionArgs(ids, { thread: 't1' })
  assert.equal(threaded.args.thread_id, 't1')
  assert.deepEqual(threaded.args.slot, { kind: 'session.select', conversation: 'c1' })
  assert.equal(assembleSessionArgs({}, { thread: null }).code, 'session_missing')
  assert.equal(assembleSessionArgs({ session: { body: {} } }, { thread: null }).code, 'input_missing')
})

test('分支装配：补源链 refs；工作区装配：body + slots；列表装配：workspaces', () => {
  const ids = idsFixture()
  const branch = assembleBranchArgs(ids, { thread: null })
  assert.deepEqual(branch.args.refs, ids.session.refs)
  const write = assembleWorkspaceWriteArgs(ids, { thread: null })
  assert.deepEqual(write.args, {
    body: ids.workspace.body,
    slots: ids.input.body,
    thread_id: '_main',
    slot: ids.input.body.slots._main,
  })
  assert.deepEqual(assembleWorkspaceListArgs(ids), { workspaces: ids.workspace.body.workspaces })
  assert.deepEqual(assembleWorkspaceListArgs({}), { workspaces: [] })
})

test('工作区写装配：投影回落代码 body（无 workspaces）时归一为规范空体，不误传代码体', () => {
  const ids = idsFixture()
  // 无数据世代：投影 body 回落代码 commit body（{meta,tree}）
  ids.workspace = { body: { meta: { name: 'workspace', version: 1 }, tree: 'a'.repeat(64) } }
  const write = assembleWorkspaceWriteArgs(ids, { thread: null })
  assert.deepEqual(write.args.body, { version: 1, workspaces: [] })
  assert.equal(Object.hasOwn(write.args.body, 'tree'), false, '不得把代码体字段带进工作区数据体')
})

test('reveal 装配：只取 id 与列表；缺 id 抛 BadArgsError', () => {
  assert.deepEqual(assembleRevealArgs({ workspace: 'w1', workspaces: [{ id: 'w1', path: '/a' }] }), {
    workspace: 'w1',
    workspaces: [{ id: 'w1', path: '/a' }],
  })
  assert.deepEqual(assembleRevealArgs({ workspace: 'w1' }), { workspace: 'w1', workspaces: [] })
  assert.throws(() => assembleRevealArgs({}), BadArgsError)
  assert.throws(() => assembleRevealArgs(null), BadArgsError)
})

// ---- 方法处理器：服务装配 + 反向调用 args ----

test('newConversation：装配槽体后反向调 session.new_conversation，计划原样上提', async () => {
  const ids = idsFixture()
  const plan = sessionPlan({ ok: true, conversation: 'c2' })
  const session = recordingPort({ ok: true, value: plan })
  const workspace = recordingPort({ ok: true, value: null })
  const handlers = createHandlers({ identity: 'ui-sidebar', session, workspace })
  const value = await handlers.newConversation(ids, { run: 'r', thread: null, now: 0 })
  assert.deepEqual(session.calls, [
    {
      port: 'session',
      method: 'new_conversation',
      args: {
        session: ids.session.body,
        slots: ids.input.body,
        thread_id: '_main',
        slot: ids.input.body.slots._main,
      },
    },
  ])
  assert.deepEqual(value, plan)
})

test('select / rename / delete / restore：各自反向调同名 session 方法', async () => {
  const ids = idsFixture()
  for (const [handler, method] of [
    ['selectConversation', 'select'],
    ['renameConversation', 'rename'],
    ['deleteConversation', 'delete'],
    ['restoreConversation', 'restore'],
  ]) {
    const plan = sessionPlan({ ok: true, method })
    const session = recordingPort({ ok: true, value: plan })
    const handlers = createHandlers({ identity: 'ui-sidebar', session, workspace: recordingPort({ ok: true, value: null }) })
    const value = await handlers[handler](ids, { run: null, thread: null, now: 0 })
    assert.equal(session.calls.length, 1)
    assert.equal(session.calls[0].port, 'session')
    assert.equal(session.calls[0].method, method)
    assert.deepEqual(value, plan)
  }
})

test('branch：反向调 session.branch 且携带 refs', async () => {
  const ids = idsFixture()
  const session = recordingPort({ ok: true, value: sessionPlan({ ok: true, conversation: 'c9' }) })
  const handlers = createHandlers({ identity: 'ui-sidebar', session, workspace: recordingPort({ ok: true, value: null }) })
  await handlers.branchConversation(ids, { run: null, thread: null, now: 0 })
  assert.equal(session.calls[0].method, 'branch')
  assert.deepEqual(session.calls[0].args.refs, ids.session.refs)
})

test('per-thread 槽键控：env.thread 决定 thread_id 与所读槽键（缺省 _main）', async () => {
  const ids = idsFixture()
  const session = recordingPort({ ok: true, value: sessionPlan({ ok: true }) })
  const handlers = createHandlers({ identity: 'ui-sidebar', session, workspace: recordingPort({ ok: true, value: null }) })
  await handlers.selectConversation(ids, { run: null, thread: 't1', now: 0 })
  assert.equal(session.calls[0].args.thread_id, 't1')
  assert.deepEqual(session.calls[0].args.slot, { kind: 'session.select', conversation: 'c1' })
})

test('工作区写类：add / remove 反向调 workspace，携带 body + slots', async () => {
  const ids = idsFixture()
  const workspace = recordingPort({ ok: true, value: sessionPlan({ ok: true, workspace: 'w1' }) })
  const handlers = createHandlers({ identity: 'ui-sidebar', session: recordingPort({ ok: true, value: null }), workspace })
  await handlers.addWorkspace(ids, { run: null, thread: null, now: 0 })
  assert.deepEqual(workspace.calls[0], {
    port: 'workspace',
    method: 'add',
    args: { body: ids.workspace.body, slots: ids.input.body, thread_id: '_main', slot: ids.input.body.slots._main },
  })
  await handlers.removeWorkspace(ids, { run: null, thread: null, now: 0 })
  assert.equal(workspace.calls[1].method, 'remove')
})

test('读命令与纯动作：list / pick / reveal 反向调用并外包 extern', async () => {
  const ids = idsFixture()
  const workspace = recordingPort({ ok: true, value: [{ id: 'w1', name: 'A', path: '/a', missing: false }] })
  const handlers = createHandlers({ identity: 'ui-sidebar', session: recordingPort({ ok: true, value: null }), workspace })
  const list = await handlers.listWorkspaces(ids, { run: null, thread: null, now: 0 })
  assert.deepEqual(workspace.calls[0], { port: 'workspace', method: 'list', args: { workspaces: ids.workspace.body.workspaces } })
  assert.deepEqual(list, { $directives: [{ kind: 'extern', payload: [{ id: 'w1', name: 'A', path: '/a', missing: false }] }] })
  await handlers.pickWorkspace(null, { run: null, thread: null, now: 0 })
  assert.deepEqual(workspace.calls[1], { port: 'workspace', method: 'pick', args: {} })
  await handlers.revealWorkspace({ workspace: 'w1', workspaces: [{ id: 'w1', path: '/a' }] }, { run: null, thread: null, now: 0 })
  assert.deepEqual(workspace.calls[2], {
    port: 'workspace',
    method: 'reveal',
    args: { workspace: 'w1', workspaces: [{ id: 'w1', path: '/a' }] },
  })
})

test('装配失败 / 反向调用失败：只回 extern 错误，不构造写计划', async () => {
  const failed = recordingPort({ ok: false, code: 'not_loaded', message: 'x' })
  const handlers = createHandlers({ identity: 'ui-sidebar', session: failed, workspace: failed })
  const missing = await handlers.newConversation({}, { run: null, thread: null, now: 0 })
  assert.equal(failed.calls.length, 0, '装配失败不应发反向调用')
  assert.equal(missing.$directives[0].payload.error.code, 'session_missing')

  const ids = idsFixture()
  const value = await handlers.selectConversation(ids, { run: null, thread: null, now: 0 })
  assert.equal(value.$directives[0].payload.error.code, 'not_loaded')
})

test('ping 回身份占位', () => {
  const handlers = createHandlers({ identity: 'ui-sidebar', session: recordingPort({ ok: true, value: null }), workspace: recordingPort({ ok: true, value: null }) })
  assert.deepEqual(handlers.ping(), { pong: true, identity: 'ui-sidebar' })
})

// ---- 帧 / 路由 / 端口 / 静态 / SSE / 入站桥 ----

test('帧编解码往返', () => {
  const decoder = createFrameDecoder()
  const frame = encodeFrame({ kind: 'call', id: '1' })
  assert.deepEqual(decoder.push(frame), [{ kind: 'call', id: '1' }])
  // 分片到达
  const decoder2 = createFrameDecoder()
  const second = encodeFrame({ kind: 'result', id: '2' })
  assert.deepEqual(decoder2.push(second.subarray(0, 3)), [])
  assert.deepEqual(decoder2.push(second.subarray(3)), [{ kind: 'result', id: '2' }])
})

test('入站桥帧构造、回包解释与计划解包', () => {
  assert.deepEqual(commandFrame('i', 'session.new', null, { thread: 't' }), { v: '1', id: 'i', kind: 'command', name: 'session.new', args: null, thread: 't' })
  assert.equal(submitFrame('i', []).kind, 'submit')
  const error = interpretResponse({ ok: true, frame: { kind: 'error', code: 'unknown_command', message: 'x' }, code: '', message: '' })
  assert.equal(error.ok, false)
  assert.equal(error.code, 'unknown_command')
  const ok = interpretResponse({
    ok: true,
    frame: { kind: 'result', observations: [{ kind: 'eval', ok: true, value: { $directives: [{ kind: 'extern', payload: { ok: true, conversation: 'c2' } }] } }] },
    code: '',
    message: '',
  })
  assert.deepEqual(extractValue(ok.frame), { ok: true, conversation: 'c2' })
  assert.deepEqual(unwrapPlan({ plain: 1 }), { plain: 1 })
})

test('路由判定：静态 / api 动词门禁（含 cancel）；/events 已并入壳总线', () => {
  assert.deepEqual(routeOf('GET', '/entry.js'), { kind: 'entry' })
  assert.deepEqual(routeOf('GET', '/badges.js'), { kind: 'web', name: 'badges.js' })
  assert.equal(routeOf('POST', '/entry.js').kind, 'not-found')
  assert.equal(routeOf('GET', '/events').kind, 'not-found')
  assert.equal(routeOf('GET', '/api/state').kind, 'not-found')
  assert.equal(routeOf('POST', '/api/command').kind, 'api-command')
  assert.equal(routeOf('POST', '/api/submit').kind, 'api-submit')
  assert.equal(routeOf('POST', '/api/cancel').kind, 'api-cancel')
  assert.equal(routeOf('GET', '/api/cancel').kind, 'not-found')
  assert.equal(routeOf('GET', '/../plugin.json').kind, 'not-found')
})

test('端口推导与静态白名单', () => {
  assert.equal(DEFAULT_SIDEBAR_PORT, 8791)
  assert.equal(resolvePort({}), 8791)
  assert.equal(resolvePort({ CHRONO_UI_PORT_UI_SIDEBAR: '9001' }), 9001)
  assert.equal(resolvePort({ CHRONO_UI_PORT_UI_SIDEBAR: '0' }), 8791)
  assert.equal(parsePort('70000'), null)
  assert.equal(WEB_FILE_RE.test('entry.js'), true)
  assert.equal(WEB_FILE_RE.test('../x.js'), false)
  assert.equal(readWebFile(WEB, 'entry.js').includes('export async function mount'), true)
  assert.equal(readWebFile(WEB, 'nope.js'), null)
  assert.equal(readWebFile(WEB, '../plugin.json'), null)
})

// ---- 服务协议级 ----

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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

test('服务协议级：hello → manifest，ping，probe，drain → bye', async () => {
  const root = tempDir('service')
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-sidebar'),
      CHRONO_UI_PORT_UI_SIDEBAR: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = createDecoder()
  const messages = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      messages.push(message)
      for (const waiter of [...waiters]) waiter()
    }
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  function waitFor(predicate, label, timeoutMs = 10000) {
    return new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        if (predicate()) {
          resolveWait()
          return
        }
        if (Date.now() > deadline) {
          rejectWait(new Error(`timeout waiting ${label}; stderr=${stderr.join('')}`))
          return
        }
        const waiter = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          check()
        }
        waiters.push(waiter)
        setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          check()
        }, 50).unref?.()
      }
      check()
    })
  }

  try {
    child.stdin.write(encode({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-sidebar', gen: 'g' }))
    await waitFor(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-sidebar')
    assert.deepEqual(manifest.implements, ['ui-sidebar'])
    assert.deepEqual(manifest.methods['ui-sidebar'], [
      'ping',
      'newConversation',
      'selectConversation',
      'renameConversation',
      'deleteConversation',
      'restoreConversation',
      'branchConversation',
      'listWorkspaces',
      'pickWorkspace',
      'addWorkspace',
      'removeWorkspace',
      'revealWorkspace',
    ])
    assert.equal(manifest.v, '1')

    child.stdin.write(encode({ v: '1', id: 'c1', kind: 'call', port: 'ui-sidebar', method: 'ping', args: {} }))
    await waitFor(() => messages.some((message) => message.id === 'c1'), 'ping')
    assert.equal(messages.find((message) => message.id === 'c1').value.pong, true)

    // 反向调用：newConversation 发 port.call session.new_conversation。
    child.stdin.write(
      encode({
        v: '1',
        id: 'n1',
        kind: 'call',
        port: 'ui-sidebar',
        method: 'newConversation',
        args: {
          session: { body: { version: 1, current: null, conversations: [] }, refs: {} },
          input: { body: { slots: { _main: { kind: 'session.new', workspace_id: 'w1' } } } },
          workspace: { body: { version: 1, workspaces: [] } },
        },
      }),
    )
    await waitFor(() => messages.some((message) => message.kind === 'port.call'), 'port.call')
    const portCall = messages.find((message) => message.kind === 'port.call')
    assert.equal(portCall.port, 'session')
    assert.equal(portCall.method, 'new_conversation')
    assert.equal(portCall.args.thread_id, '_main')
    assert.deepEqual(portCall.args.slot, { kind: 'session.new', workspace_id: 'w1' })
    child.stdin.write(encode({ v: '1', id: portCall.id, kind: 'port.result', ok: true, value: sessionPlan({ ok: true, conversation: 'c2' }) }))
    await waitFor(() => messages.some((message) => message.id === 'n1'), 'newConversation result')
    assert.deepEqual(messages.find((message) => message.id === 'n1').value, sessionPlan({ ok: true, conversation: 'c2' }))

    child.stdin.write(encode({ v: '1', id: 'p1', kind: 'probe' }))
    await waitFor(() => messages.some((message) => message.id === 'p1'), 'pong')
    assert.equal(messages.find((message) => message.id === 'p1').kind, 'pong')

    child.stdin.write(encode({ v: '1', id: 'd1', kind: 'drain', deadline_ms: 100 }))
    await waitFor(() => messages.some((message) => message.id === 'd1'), 'bye')
    assert.equal(messages.find((message) => message.id === 'd1').kind, 'bye')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

test('服务 EOF 自退出', async () => {
  const root = tempDir('eof')
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-sidebar'),
      CHRONO_UI_PORT_UI_SIDEBAR: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exit = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.stdin.end()
  const code = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('service did not exit on EOF')), 8000))])
  assert.equal(typeof code, 'number')
  rmSync(root, { recursive: true, force: true })
})

test('entry.js 导出 mount 且返回 unmount（模块可导入）', async () => {
  const module = await import(pathToFileURL(join(WEB, 'entry.js')).href)
  assert.equal(module.contract, '1')
  assert.equal(typeof module.mount, 'function')
  assert.ok(module.mount.length >= 2)
})
