// 服务装配层测试：三条命令的计划形状（含 `eval(command:'chat.resume')` 拼接与 per-thread 清槽）、
// list 只读、坏槽 kind 结构化拒、反向调用失败收口。反向调用的 `#32` 端口由假实现注入。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assembleDecideArgs,
  assembleListArgs,
  buildDecisionPlan,
  createHandlers,
  decideSlotOf,
} from '../execute/methods.ts'
import {
  addGenOp,
  clearSlotsBody,
  externOnly,
  failure,
  normalizeVerdict,
  planOf,
  putOp,
  resumeDirectives,
  shadowRefsOf,
  withExternPayload,
} from '../execute/plan.ts'

import { createRefHydrator } from '../execute/refs.ts'

const ENV = { run: 'run-1', thread: 't1', now: 0 }

/** 假审批端口：记录调用并回固定 outcome（`{ok:true,value}` / `{ok:false,code,message}`）。 */
function fakeApproval(outcome) {
  const calls = []
  return {
    calls,
    call: async (port, method, args) => {
      calls.push({ port, method, args })
      return outcome
    },
  }
}

/** 由 item 定义链（oldest→newest）造队列 body + 引用闭包。 */
function queueFixture(items) {
  const refs = {}
  let prev = null
  items.forEach((item, index) => {
    const hash = (index + 1).toString(16).padStart(64, '0')
    refs[hash] = { ...item, prev }
    prev = { def: hash }
  })
  return { queue: { version: 1, tail: prev, count: items.length }, refs }
}

function idsFixture(inputSlots, items) {
  const { queue, refs } = queueFixture(items)
  return {
    input: { body: { slots: inputSlots } },
    approval: { body: queue, refs },
  }
}

function approvalPlan(id, status) {
  return planOf([putOp({ id, status }), addGenOp('approval', 0)], { ok: true, id, status })
}

test('assembleListArgs：只取队列 body 与引用闭包', () => {
  const ids = idsFixture({ _main: { kind: 'idle' } }, [])
  assert.deepEqual(assembleListArgs(ids), { queue: { version: 1, tail: null, count: 0 }, refs: {} })
  assert.deepEqual(assembleListArgs(null), { queue: { version: 1, tail: null, count: 0 }, refs: {} })
})

test('list：只读——反向调 #32 list，不构造任何 write', async () => {
  const items = [{ id: 'ap-r-0', kind: 'tool_call', port: 'tool-shell', status: 'pending', thread: 't1', at: '2026-09-20T00:00:00.000Z', resume: null }]
  const ids = idsFixture({ _main: { kind: 'idle' } }, items)
  const approval = fakeApproval({ ok: true, value: externOnly({ ok: true, pending: 1, expired: 0, items: [...items].reverse() }) })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const value = await handlers.list(ids, ENV)

  assert.equal(approval.calls.length, 1)
  assert.equal(approval.calls[0].port, 'approval')
  assert.equal(approval.calls[0].method, 'list')
  assert.deepEqual(approval.calls[0].args, assembleListArgs(ids))
  assert.equal(value.$directives.length, 1)
  assert.equal(value.$directives[0].kind, 'extern')
  assert.equal(value.$directives[0].payload.pending, 1)
})

test('list：反向调用失败收口为结构化 extern（不崩）', async () => {
  const approval = fakeApproval({ ok: false, code: 'not_loaded', message: 'x' })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const value = await handlers.list(idsFixture({}, []), ENV)
  assert.equal(value.$directives[0].payload.ok, false)
  assert.equal(value.$directives[0].payload.error.code, 'not_loaded')
})

test('list：附各 item 的 shadow def body（编排变更卡片解析影子指标用）', async () => {
  const shadowHash = 'b'.repeat(64)
  const items = [
    { id: 'ap-x', kind: 'orchestration_change', status: 'pending', thread: 't1', at: '2026-09-20T00:00:00.000Z', shadow: { def: shadowHash }, resume: null },
    { id: 'ap-y', kind: 'tool_call', status: 'pending', thread: 't1', at: '2026-09-20T00:00:00.000Z', shadow: null, resume: null },
  ]
  const ids = idsFixture({ _main: { kind: 'idle' } }, items)
  ids.approval.refs[shadowHash] = { rounds: 4, metrics: {} }
  const approval = fakeApproval({ ok: true, value: externOnly({ ok: true, items: [...items].reverse() }) })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const value = await handlers.list(ids, ENV)
  assert.equal(value.$directives[0].payload.refs[shadowHash].rounds, 4)
  assert.deepEqual(Object.keys(value.$directives[0].payload.refs), [shadowHash])
})

test('纯函数：shadowRefsOf 只收可达 shadow body，withExternPayload 只并 extern', () => {
  const hash = 'c'.repeat(64)
  const refs = { [hash]: { rounds: 1 } }
  assert.deepEqual(shadowRefsOf([{ shadow: { def: hash } }, { shadow: null }, { shadow: { def: 'd'.repeat(64) } }], refs), { [hash]: { rounds: 1 } })
  const plan = externOnly({ ok: true })
  assert.equal(withExternPayload(plan, { refs: {} }).$directives[0].payload.refs !== undefined, true)
  assert.deepEqual(withExternPayload({ plain: 1 }, { refs: {} }), { plain: 1 })
})

test('decide：读槽 → 反向调 #32 decide → 拼 [#32 计划, chat.resume]（审批写在前）', async () => {
  const items = [
    {
      id: 'ap-r-0',
      kind: 'tool_call',
      port: 'tool-shell',
      status: 'pending',
      thread: 't1',
      at: '2026-09-20T00:00:00.000Z',
      resume: { command: 'chat.resume', args: { cursor: { iter: 3 }, thread: 't1' } },
    },
  ]
  const slots = { t1: { kind: 'approval.decide', id: 'ap-r-0', verdict: 'accept' }, _main: { kind: 'idle' } }
  const ids = idsFixture(slots, items)
  const approval = fakeApproval({ ok: true, value: approvalPlan('ap-r-0', 'approved') })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const value = await handlers.decide(ids, ENV)

  assert.equal(approval.calls[0].method, 'decide')
  assert.deepEqual(approval.calls[0].args.slots, ids.input.body)
  assert.equal(approval.calls[0].args.thread_id, 't1')

  const directives = value.$directives
  assert.equal(directives.length, 3, '[#32 batch, #32 extern, eval]')
  assert.equal(directives[0].kind, 'write')
  assert.equal(directives[0].request.op, 'batch')
  assert.equal(directives[1].kind, 'extern')
  assert.equal(directives[1].payload.status, 'approved')
  assert.deepEqual(directives[2], {
    kind: 'eval',
    command: 'chat.resume',
    args: { cursor: { iter: 3 }, thread: 't1', payload: { verdict: 'accept' } },
    inject: { ids: ['ids'] },
  })
})

test('decide：坏槽 kind 结构化拒并 per-thread 清槽（不调 #32）', async () => {
  const approval = fakeApproval({ ok: true, value: externOnly({ ok: true }) })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const ids = idsFixture({ t1: { kind: 'chat.message', text: 'x' }, t2: { kind: 'idle' } }, [])
  const value = await handlers.decide(ids, ENV)

  assert.equal(approval.calls.length, 0, '坏槽不调 #32')
  const batch = value.$directives[0]
  assert.equal(batch.kind, 'write')
  const body = batch.request.args.ops[0].args.body
  assert.equal(body.slots.t1.kind, 'idle', '本线程键清为 idle')
  assert.equal(body.slots.t2.kind, 'idle', '其它线程键原样保留')
  assert.equal(value.$directives[1].payload.ok, false)
  assert.equal(value.$directives[1].payload.error.code, 'bad_slot')
})

test('decide：无输入槽投影时收口为纯 extern（无可清 body）', async () => {
  const approval = fakeApproval({ ok: true, value: externOnly({ ok: true }) })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const value = await handlers.decide({ approval: { body: { version: 1, tail: null, count: 0 }, refs: {} } }, ENV)
  assert.equal(value.$directives.length, 1)
  assert.equal(value.$directives[0].payload.error.code, 'bad_slot')
})

test('decide：反向调用失败也清槽（失败也清，防残留非法 kind）', async () => {
  const approval = fakeApproval({ ok: false, code: 'transport_failed', message: 'timeout' })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const ids = idsFixture(
    { t1: { kind: 'approval.decide', id: 'ap-r-0', verdict: 'deny' }, _main: { kind: 'idle' } },
    [{ id: 'ap-r-0', status: 'pending', thread: 't1', at: '2026-09-20T00:00:00.000Z', resume: null }],
  )
  const value = await handlers.decide(ids, ENV)
  assert.equal(value.$directives[0].kind, 'write')
  assert.equal(value.$directives[0].request.args.ops[0].args.body.slots.t1.kind, 'idle')
  assert.equal(value.$directives[1].payload.error.code, 'transport_failed')
})

test('decide_all：只对 pending 项逐条产 chat.resume，非 pending 跳过', async () => {
  const items = [
    { id: 'ap-a', status: 'approved', thread: 't0', at: '2026-09-20T00:00:00.000Z', resume: { command: 'chat.resume', args: { cursor: 'c0', thread: 't0' } } },
    { id: 'ap-b', status: 'pending', thread: 't1', at: '2026-09-20T00:00:00.000Z', resume: { command: 'chat.resume', args: { cursor: 'c1', thread: 't1' } } },
    { id: 'ap-c', status: 'pending', thread: 't2', at: '2026-09-20T00:00:00.000Z', resume: { command: 'chat.resume', args: { cursor: 'c2', thread: 't2' } } },
  ]
  const ids = idsFixture({ _main: { kind: 'approval.decide', verdict: 'deny' } }, items)
  const approval = fakeApproval({ ok: true, value: approvalPlan('ap-b', 'denied') })
  const handlers = createHandlers({ identity: 'ui-approval', approval, webRoot: process.cwd() })
  const value = await handlers.decide_all(ids, { run: 'r', thread: null, now: 0 })

  assert.equal(approval.calls[0].method, 'decide_all')
  assert.equal(approval.calls[0].args.thread_id, '_main')
  const evals = value.$directives.filter((item) => item.kind === 'eval')
  assert.deepEqual(evals.map((item) => item.args.cursor), ['c2', 'c1'], 'pending 项倒序逐条续跑，approved 跳过')
  assert.equal(evals[0].args.thread, 't2')
  assert.equal(evals[0].args.payload.verdict, 'deny')
  assert.equal(evals[0].args.ids, undefined, '续跑不再内嵌整份投影')
  assert.deepEqual(evals[0].inject, { ids: ['ids'] }, '投影由宿主执行期注入')
  assert.equal(value.$directives.at(-1).kind, 'eval', '续跑排在审批写之后')
  assert.ok(value.$directives.some((item) => item.kind === 'extern'), '#32 extern 仍在内')
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

test('buildDecisionPlan：#32 计划在前、续跑条目接在其后（审批写先落账）', () => {
  const plan = [{ kind: 'write' }, { kind: 'extern' }]
  const withTarget = buildDecisionPlan(
    [{ id: 'a', thread: 't1', resume: { args: { cursor: 'c1' } } }],
    'accept',
    plan,
  )
  assert.equal(withTarget.$directives[0].kind, 'write')
  assert.equal(withTarget.$directives[1].kind, 'extern')
  assert.equal(withTarget.$directives[2].kind, 'eval')
  assert.equal(withTarget.$directives[2].command, 'chat.resume')
  // 无待续跑项时退化为原计划
  assert.deepEqual(buildDecisionPlan([], 'accept', plan).$directives, plan)
})

test('decideSlotOf：只认本线程 `approval.decide` kind', () => {
  const ids = idsFixture({ t1: { kind: 'approval.decide', id: 'a', verdict: 'accept' }, t2: { kind: 'idle' } }, [])
  assert.equal(decideSlotOf(ids, 't1').id, 'a')
  assert.equal(decideSlotOf(ids, 't2'), null)
  assert.equal(decideSlotOf(ids, 'missing'), null)
})

test('assembleDecideArgs：缺输入 body 时不带 slots（仍可调 #32）', () => {
  const args = assembleDecideArgs({ approval: { body: { version: 1, tail: null, count: 0 }, refs: {} } }, '_main')
  assert.deepEqual(args, { queue: { version: 1, tail: null, count: 0 }, refs: {}, thread_id: '_main' })
})

test('refs 按需解析：哈希列表逐跳取回闭包，与内联闭包等价；缓存跨调用复用', async () => {
  const h1 = '1'.repeat(64)
  const h2 = '2'.repeat(64)
  const h3 = '3'.repeat(64)
  const defs = {
    [h1]: { id: 'a', prev: { def: h2 } },
    [h2]: { id: 'b', prev: { def: h3 } },
    [h3]: { id: 'c', prev: null },
  }
  const calls = []
  const hydrator = createRefHydrator(async (identity, hashes) => {
    calls.push({ identity, hashes: [...hashes] })
    const out = {}
    for (const hash of hashes) if (defs[hash] !== undefined) out[hash] = defs[hash]
    return { defs: out, missing: [], denied: [], truncated: false }
  })
  // 投影只回直接引用（h1）；深层 h2 / h3 由逐跳解析取回
  const hydrated = await hydrator.hydrate('approval', [h1])
  assert.deepEqual(hydrated, defs, '逐跳解析结果与内联闭包等价')
  assert.deepEqual(calls, [
    { identity: 'approval', hashes: [h1] },
    { identity: 'approval', hashes: [h2] },
    { identity: 'approval', hashes: [h3] },
  ])

  // 已是对象（内联闭包 / 单测直给）⇒ 原样返回，不发解析调用
  const inline = { [h1]: defs[h1] }
  assert.equal(await hydrator.hydrate('approval', inline), inline)

  // 缓存复用：再次解析同一身份不再触发解析调用
  calls.length = 0
  const again = await hydrator.hydrate('approval', [h1])
  assert.deepEqual(again, defs)
  assert.deepEqual(calls, [], '命中进程内缓存，不再调宿主')
})

test('纯函数：verdict 归一 / 清槽只动本键', () => {
  assert.equal(normalizeVerdict('accept'), 'accept')
  assert.equal(normalizeVerdict('deny'), 'deny')
  assert.equal(normalizeVerdict('approved'), null)
  assert.equal(normalizeVerdict(undefined), null)
  const cleared = clearSlotsBody({ slots: { t1: { kind: 'x' }, t2: { kind: 'y' } } }, 't1')
  assert.deepEqual(cleared.slots, { t1: { kind: 'idle' }, t2: { kind: 'y' } })
  assert.deepEqual(failure('a', 'b'), { ok: false, error: { code: 'a', message: 'b' } })
})
