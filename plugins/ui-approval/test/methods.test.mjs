// 服务装配层测试：list 反向调 approval.list 并附影子指标；decide / decide_all 经 input 取槽 / 清槽、
// 反向调 approval 并拼 `eval(command:'chat.resume')` 续跑计划；反向调用失败 / 坏槽收口。假端口注入。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandlers } from '../execute/methods.ts'
import {
  allRefsOf,
  externOnly,
  failure,
  resumeDirectives,
  shadowRefsOf,
  withExternPayload,
} from '../execute/plan.ts'

const ENV = { run: 'run-1', thread: 't1', now: 0 }

/** 假反向端口：记录调用并按 (port, method) 路由回固定 outcome。 */
function fakePorts(routes) {
  const calls = []
  return {
    calls,
    call: async (port, method, args) => {
      calls.push({ port, method, args })
      const key = `${port}.${method}`
      const route = routes[key]
      if (route === undefined) return { ok: false, code: 'unexpected', message: key }
      return route
    },
  }
}

const SLOT = { kind: 'approval.decide', id: 'ap-r-0', verdict: 'accept' }

function approvalPlan(id, status) {
  return externOnly({ ok: true, id, status, verdict: 'accept', thread: 't1', resume: { command: 'chat.resume', args: { cursor: { node_index: 3 }, thread: 't1' } } })
}

test('list：反向调 approval.list（无切片参数），结果即命令结果', async () => {
  const items = [{ id: 'ap-r-0', kind: 'tool_call', status: 'pending', thread: 't1', resume: null }]
  const ports = fakePorts({ 'approval.list': { ok: true, value: externOnly({ ok: true, pending: 1, items }) } })
  const handlers = createHandlers({ identity: 'ui-approval', approval: ports, input: ports, webRoot: process.cwd() })
  const value = await handlers.list({}, ENV)

  assert.equal(ports.calls.length, 1)
  assert.deepEqual(ports.calls[0], { port: 'approval', method: 'list', args: {} })
  assert.equal(value.$directives.length, 1)
  assert.equal(value.$directives[0].kind, 'extern')
  assert.equal(value.$directives[0].payload.pending, 1)
})

test('list：反向调用失败收口为结构化 extern（不崩）', async () => {
  const ports = fakePorts({ 'approval.list': { ok: false, code: 'not_loaded', message: 'x' } })
  const handlers = createHandlers({ identity: 'ui-approval', approval: ports, input: ports, webRoot: process.cwd() })
  const value = await handlers.list({}, ENV)
  assert.equal(value.$directives[0].payload.ok, false)
  assert.equal(value.$directives[0].payload.error.code, 'not_loaded')
})

test('list：附各 item 的 shadow def body（跨身份 refs 可达者）', async () => {
  const shadowHash = 'b'.repeat(64)
  const items = [
    { id: 'ap-x', kind: 'orchestration_change', status: 'pending', thread: 't1', shadow: { def: shadowHash }, resume: null },
    { id: 'ap-y', kind: 'tool_call', status: 'pending', thread: 't1', shadow: null, resume: null },
  ]
  const ports = fakePorts({ 'approval.list': { ok: true, value: externOnly({ ok: true, items }) } })
  const handlers = createHandlers({ identity: 'ui-approval', approval: ports, input: ports, webRoot: process.cwd() })
  const ids = { evolution: { refs: { [shadowHash]: { rounds: 4, metrics: {} } } } }
  const value = await handlers.list(ids, ENV)
  assert.equal(value.$directives[0].payload.refs[shadowHash].rounds, 4)
  assert.deepEqual(Object.keys(value.$directives[0].payload.refs), [shadowHash])
})

test('decide：input.read 取槽 → 反向调 approval.decide → input.clear → 拼 [审批 extern, chat.resume]', async () => {
  const ports = fakePorts({
    'input.read': { ok: true, value: { slots: { t1: SLOT }, thread: 't1', slot: SLOT } },
    'approval.decide': { ok: true, value: approvalPlan('ap-r-0', 'approved') },
    'input.clear': { ok: true, value: { ok: true, thread: 't1' } },
  })
  const handlers = createHandlers({ identity: 'ui-approval', approval: ports, input: ports, webRoot: process.cwd() })
  const value = await handlers.decide(null, ENV)

  assert.deepEqual(ports.calls.map((call) => `${call.port}.${call.method}`), ['input.read', 'approval.decide', 'input.clear'])
  assert.deepEqual(ports.calls[1].args, { thread_id: 't1', verdict: 'accept', id: 'ap-r-0' })

  const directives = value.$directives
  assert.equal(directives.length, 2, '[审批 extern, eval]')
  assert.equal(directives[0].kind, 'extern')
  assert.equal(directives[0].payload.status, 'approved')
  assert.deepEqual(directives[1], {
    kind: 'eval',
    command: 'chat.resume',
    args: { cursor: { node_index: 3 }, thread: 't1', payload: { verdict: 'accept' } },
    inject: { ids: ['ids'] },
  })
})

test('decide：坏槽 kind → 清槽 + 结构化拒（不调 approval）', async () => {
  const ports = fakePorts({
    'input.read': { ok: true, value: { slots: { t1: { kind: 'chat.message', text: 'x' } }, thread: 't1', slot: { kind: 'chat.message', text: 'x' } } },
    'input.clear': { ok: true, value: { ok: true, thread: 't1' } },
  })
  const handlers = createHandlers({ identity: 'ui-approval', approval: ports, input: ports, webRoot: process.cwd() })
  const value = await handlers.decide(null, ENV)
  assert.deepEqual(ports.calls.map((call) => call.method), ['read', 'clear'], '坏槽不调 approval')
  assert.equal(value.$directives[0].payload.ok, false)
  assert.equal(value.$directives[0].payload.error.code, 'bad_slot')
})

test('decide：反向调 approval 失败也清槽（失败也清，防残留非法 kind）', async () => {
  const ports = fakePorts({
    'input.read': { ok: true, value: { slots: { t1: SLOT }, thread: 't1', slot: SLOT } },
    'approval.decide': { ok: false, code: 'transport_failed', message: 'timeout' },
    'input.clear': { ok: true, value: { ok: true, thread: 't1' } },
  })
  const handlers = createHandlers({ identity: 'ui-approval', approval: ports, input: ports, webRoot: process.cwd() })
  const value = await handlers.decide(null, ENV)
  assert.deepEqual(ports.calls.map((call) => call.method), ['read', 'decide', 'clear'])
  assert.equal(value.$directives[0].payload.error.code, 'transport_failed')
})

test('decide_all：只对 pending 项逐条产 chat.resume，非 pending 跳过', async () => {
  const slots = { t1: { kind: 'approval.decide', verdict: 'deny' } }
  const ports = fakePorts({
    'input.read': { ok: true, value: { slots, thread: 't1', slot: slots.t1 } },
    'approval.decide_all': {
      ok: true,
      value: externOnly({
        ok: true,
        ids: ['ap-b', 'ap-c'],
        status: 'denied',
        verdict: 'deny',
        resumes: [
          { id: 'ap-b', thread: 't1', resume: { command: 'chat.resume', args: { cursor: 'c1', thread: 't1' } } },
          { id: 'ap-c', thread: 't2', resume: { command: 'chat.resume', args: { cursor: 'c2', thread: 't2' } } },
        ],
      }),
    },
    'input.clear': { ok: true, value: { ok: true, thread: 't1' } },
  })
  const handlers = createHandlers({ identity: 'ui-approval', approval: ports, input: ports, webRoot: process.cwd() })
  const value = await handlers.decide_all(null, ENV)

  const evals = value.$directives.filter((item) => item.kind === 'eval')
  assert.deepEqual(evals.map((item) => item.args.cursor), ['c1', 'c2'])
  assert.equal(evals[0].args.thread, 't1')
  assert.equal(evals[0].args.payload.verdict, 'deny')
  assert.equal(evals[0].args.ids, undefined, '续跑不再内嵌整份投影')
  assert.deepEqual(evals[0].inject, { ids: ['ids'] }, '投影由宿主执行期注入')
  assert.ok(value.$directives.some((item) => item.kind === 'extern'), '审批 extern 仍在内')
})

test('resumeDirectives：无 resume / 无 cursor 的项跳过，不伪造游标', () => {
  const items = [
    { id: 'a', thread: 't1', resume: null },
    { id: 'b', thread: 't2', resume: { command: 'chat.resume', args: {} } },
    { id: 'c', resume: { command: 'chat.resume', args: { cursor: 'c3' } } },
  ]
  const out = resumeDirectives(items, 'accept')
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].args, { cursor: 'c3', thread: '_main', payload: { verdict: 'accept' } })
  assert.deepEqual(out[0].inject, { ids: ['ids'] })
})

test('纯函数：allRefsOf 汇总各身份 refs；shadowRefsOf 只收可达 shadow body；withExternPayload 只并 extern', () => {
  const hash = 'c'.repeat(64)
  const ids = { approval: { refs: {} }, evolution: { refs: { [hash]: { rounds: 1 } } } }
  assert.deepEqual(allRefsOf(ids), { [hash]: { rounds: 1 } })
  assert.deepEqual(shadowRefsOf([{ shadow: { def: hash } }, { shadow: null }, { shadow: { def: 'd'.repeat(64) } }], allRefsOf(ids)), { [hash]: { rounds: 1 } })
  const plan = externOnly({ ok: true })
  assert.equal(withExternPayload(plan, { refs: {} }).$directives[0].payload.refs !== undefined, true)
  assert.deepEqual(withExternPayload({ plain: 1 }, { refs: {} }), { plain: 1 })
  assert.deepEqual(failure('a', 'b'), { ok: false, error: { code: 'a', message: 'b' } })
})
