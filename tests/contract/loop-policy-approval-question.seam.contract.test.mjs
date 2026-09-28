// 接缝契约 7：loop-policy ↔ approval / question。
// 共享真源：chain-contract/fixtures/step-records.json 的回合身份与 node-io.json 的派发 bag 形状。
// 消费方向：真实 approval / question 服务消费挂起入参（含 loop-policy 装配的 resume 游标）。
// 供给方向：真实 loop-policy 解释器从游标恢复，且 `turn_id` 跨 run 不变。
// 至少一侧为真实服务：两侧都是真实服务（approval / question 经 plugin-sdk 协议起进程）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startService as startLoop, defaultProviders, portError } from '../../plugins/loop-policy/test/driver.mjs'
import { startRealService, stopRealService } from './_bridge.mjs'

let dirSeq = 0
function tempDataDir(prefix) {
  dirSeq += 1
  return mkdtempSync(join(tmpdir(), `${prefix}-${process.pid}-${dirSeq}-`))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** loop-policy 测试驱动的反向调用应答：真实服务 `result` 帧取 `value`，`error` 帧转 `portError`。 */
function forward(service) {
  return (args, message) =>
    service.call(message.port, message.method, args, message.env).then((frame) =>
      frame.kind === 'error' ? portError(frame.error, frame.message) : frame.value,
    )
}

function startApproval(dir) {
  return startRealService({ name: 'approval', env: { CHRONO_PLUGIN_DATA: dir, CHRONO_PLUGIN_STATE: dir } })
}

function startQuestion(dir) {
  let answerSlot = null
  const service = startRealService({
    name: 'question',
    env: { CHRONO_PLUGIN_DATA: dir, CHRONO_PLUGIN_STATE: dir },
    onPortCall: (message) => {
      if (message.port === 'input' && message.method === 'read') return { ok: true, value: { slot: answerSlot } }
      if (message.port === 'input' && message.method === 'clear') return { ok: true, value: { ok: true } }
      return { ok: false, code: 'unresolved_cap', message: `${message.port}.${message.method}` }
    },
  })
  return { service, setAnswer: (slot) => { answerSlot = slot } }
}

const ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

const WEBFETCH = [
  {
    name: 'webfetch',
    provider: 'tool-http',
    kind: 'invoke',
    method: null,
    read: null,
    description: 'fetch a url',
    argsSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    caps: { fs: { read: 'none', write: 'none' }, net: 'all' },
    idempotent: true,
  },
]

/** 门禁一律 escalate（本文件只考审批/提问接缝，guard 接缝另有专测）。 */
const ESCALATE = (args) => ({
  decisions: (Array.isArray(args.calls) ? args.calls : []).map((call, index) => ({
    index,
    port: call.port ?? '',
    tool: call.tool ?? '',
    verdict: 'escalate',
    reason: 'net_outside_tier',
    rule: 'all',
  })),
  summary: { allow: 0, escalate: (args.calls ?? []).length, deny: 0 },
})

function approvalSummary(result) {
  return result.value.$directives.find((directive) => directive.kind === 'extern' && directive.payload?.kind === 'interpret')?.payload
}

test('接缝 7a：真实 approval 消费挂起入参；真实 loop-policy 从同 turn_id 游标恢复', async () => {
  const dir = tempDataDir('seam-approval')
  const approval = startApproval(dir)
  const dispatchBags = []
  const loop = startLoop({
    providers: defaultProviders({
      'context.build': (args) => ({
        messages: [{ role: 'user', content: 'fetch example' }, ...(Array.isArray(args.extra_messages) ? clone(args.extra_messages) : [])],
        params: { model: 'stub-model' },
        manifest: { dropped: 0 },
      }),
      'model.chat': (args) => {
        const last = args.messages?.[args.messages.length - 1]
        if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: {} }
        return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'webfetch', args: { url: 'https://example.com' } }], usage: {} }
      },
      'guard.judge': (args) => ESCALATE(args),
      'tools.dispatch': (args) => {
        dispatchBags.push(clone(args))
        return { results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { fetched: true } })) }
      },
      'approval.enqueue': forward(approval),
    }),
  })
  try {
    await approval.hello()
    const turnId = 't-seam-7a'
    const first = await loop.interpret({
      tier: 'severe',
      turn_id: turnId,
      tools: clone(WEBFETCH),
      sandbox_tiers: { tiers: { severe: { net: 'limited' } } },
    })
    assert.equal(first.kind, 'result', JSON.stringify(first))
    // approval.wait 挂起，未派发工具。
    assert.equal(dispatchBags.length, 0)
    assert.equal(approvalSummary(first).pending, 'approval')

    // 真实 approval 服务消费了挂起入参：队列项 + resume 游标（回合身份随游标延续）。
    const listed = await approval.call('approval', 'list', {}, { run: 'run-1', thread: 't1', now: 1_700_000_000_000 })
    assert.equal(listed.kind, 'result', JSON.stringify(listed))
    const items = listed.value.$directives[0].payload.items
    assert.equal(items.length, 1)
    assert.equal(items[0].kind, 'tool_call')
    assert.equal(items[0].status, 'pending')
    assert.equal(items[0].resume.command, 'chat.resume')
    const cursor = items[0].resume.args.cursor
    assert.equal(cursor.kind, 'approval')
    assert.equal(cursor.turn_id, turnId, '游标须延续同一 turn_id')

    // 供给方向：真实 loop-policy 从该游标恢复，同一 turn_id 续跑，批准签发一次性 grant 后派发。
    const second = await loop.interpret({
      tier: 'severe',
      turn_id: turnId,
      tools: clone(WEBFETCH),
      sandbox_tiers: { tiers: { severe: { net: 'limited' } } },
      resume: { cursor, thread: 't1', payload: { verdict: 'approved' } },
    })
    assert.equal(second.kind, 'result', JSON.stringify(second))
    assert.equal(dispatchBags.length, 1, '批准后续跑应派发工具')
    assert.equal(dispatchBags[0].verdicts, 'approved')
    assert.equal(dispatchBags[0].grant?.net, 'all', '批准签发一次性 net 放宽')
    assert.equal(approvalSummary(second).turn_id, turnId, '续跑回合身份不变')
  } finally {
    loop.close()
    await loop.exit
    await stopRealService(approval)
    rmSync(dir, { recursive: true, force: true })
  }
})

const QUESTION_TOOL = [
  {
    name: 'question',
    provider: 'question',
    kind: 'binding',
    method: 'invoke',
    read: null,
    description: 'ask the user',
    argsSchema: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'] },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
    idempotent: false,
  },
]

test('接缝 7b：真实 question 入队消费挂起入参；真实 loop-policy 从同 turn_id 游标恢复作答', async () => {
  const dir = tempDataDir('seam-question')
  const question = startQuestion(dir)
  const seenModel = []
  const loop = startLoop({
    providers: defaultProviders({
      'context.build': (args) => ({
        messages: [{ role: 'user', content: 'which file?' }, ...(Array.isArray(args.extra_messages) ? clone(args.extra_messages) : [])],
        params: { model: 'stub-model' },
        manifest: { dropped: 0 },
      }),
      'model.chat': (args) => {
        seenModel.push(clone(args))
        const last = args.messages?.[args.messages.length - 1]
        if (last && last.role === 'tool') return { ok: true, text: 'thanks', tool_calls: [], usage: {} }
        return { ok: true, text: '', tool_calls: [{ id: 'q-call', name: 'question', args: { questions: [{ id: 'q1', question: '哪个文件？', options: [] }] } }], usage: {} }
      },
      'guard.judge': (args) => ({ decisions: (args.calls ?? []).map((call, index) => ({ index, port: call.port ?? '', tool: call.tool ?? '', verdict: 'allow' })), summary: { allow: (args.calls ?? []).length, escalate: 0, deny: 0 } }),
      // question 工具经真实 question 服务入队：消费 loop-policy 随 dispatchBag 下传的 resume 游标。
      'tools.dispatch': (args) =>
        question.service
          .call('question', 'invoke', {
            tool: 'question',
            args: args.calls[0].args,
            cursor: args.cursor,
            run: ENV.run,
            thread: ENV.thread,
          }, ENV)
          .then((frame) => {
            if (frame.kind === 'error') return portError(frame.error, frame.message)
            return { results: [{ call_id: args.calls[0].call_id, tool: 'question', ok: true, result: frame.value }] }
          }),
    }),
  })
  try {
    await question.service.hello()
    const turnId = 't-seam-7b'
    const first = await loop.interpret({
      tier: 'auto',
      turn_id: turnId,
      tools: clone(QUESTION_TOOL),
    })
    assert.equal(first.kind, 'result', JSON.stringify(first))
    // 提问是段终态 awaiting：本段以 pending 结束，回合不在此收口。
    assert.equal(approvalSummary(first).pending, 'question')

    // 真实 question 服务消费了挂起入参：队列项 + resume 游标（同 turn_id）。
    const listed = await question.service.call('question', 'list', {}, { run: 'run-1', thread: 't1', now: 1_700_000_000_000 })
    assert.equal(listed.kind, 'result', JSON.stringify(listed))
    const items = listed.value.$directives[0].payload.items
    assert.equal(items.length, 1)
    assert.equal(items[0].questions[0].id, 'q1')
    const cursor = items[0].resume.args.cursor
    assert.equal(cursor.kind, 'question')
    assert.equal(cursor.turn_id, turnId, '游标须延续同一 turn_id')

    // 作答：真实 question 服务经 `question.answer` 命令产续跑计划（同游标）。
    question.setAnswer({ kind: 'question.answer', id: items[0].id, answers: [{ question_id: 'q1', selected: ['foo.ts'] }] })
    const answered = await question.service.call('question', 'invoke', {}, { run: 'run-1', thread: 't1', now: 1_700_000_000_000 })
    assert.equal(answered.kind, 'result', JSON.stringify(answered))
    const resumeDirective = answered.value.$directives.find((directive) => directive.kind === 'eval' && directive.command === 'chat.resume')
    assert.ok(resumeDirective !== undefined, JSON.stringify(answered.value))
    assert.equal(resumeDirective.args.cursor.turn_id, turnId)

    // 供给方向：真实 loop-policy 从作答游标恢复，同 turn_id 续跑，模型看到答案。
    const second = await loop.interpret({
      tier: 'auto',
      turn_id: turnId,
      tools: clone(QUESTION_TOOL),
      resume: { cursor: resumeDirective.args.cursor, thread: 't1', payload: { answers: [{ question_id: 'q1', selected: ['foo.ts'] }] } },
    })
    assert.equal(second.kind, 'result', JSON.stringify(second))
    assert.equal(approvalSummary(second).turn_id, turnId)
    const fed = seenModel[seenModel.length - 1].messages.find((message) => message.role === 'tool' && String(message.content).includes('foo.ts'))
    assert.ok(fed !== undefined, '作答须回灌模型')
  } finally {
    loop.close()
    await loop.exit
    await stopRealService(question.service)
    rmSync(dir, { recursive: true, force: true })
  }
})
