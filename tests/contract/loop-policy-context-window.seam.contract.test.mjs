// 接缝契约 4：loop-policy ↔ context-window。
// 共享真源：chain-contract/fixtures/node-io.json 的 `context.assemble` 输入 / 输出形状。
// 消费方向：真实 context-window 服务（原生 tokenizer）消费真实 loop-policy 装配的 assemble bag。
// 供给方向：真实 loop-policy 解释器消费真实 context-window 返回的消息数组 + 参数 / 用量。
// 至少一侧为真实服务：两侧都是真实服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nodeIo } from '../../chain-contract/fixtures/index.ts'
import { interpretBag } from '../../chain-contract/fixtures/index.ts'
import { startService as startLoop, defaultProviders } from '../../plugins/loop-policy/test/driver.mjs'
import { startRealService, stopRealService, FIXED_ENV } from './_bridge.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// context-window 把原生 tokenizer 复制进 `CHRONO_PLUGIN_STATE`（缺省则写包内 target/release）。
// 隔离到临时目录：既不写仓库，也避免多进程共用一个 .node 副本。
function startContext() {
  const stateDir = mkdtempSync(join(tmpdir(), `seam-context-${process.pid}-`))
  const service = startRealService({
    name: 'context-window',
    env: { CHRONO_PLUGIN_STATE: stateDir, CHRONO_PLUGIN_DATA: stateDir },
    // context-window 现经 needs 反调 token-estimate / budget；本接缝用夹具应答（形状对齐 port-link.ts）。
    onPortCall: (message) => {
      if (message.port === 'token-estimate' && message.method === 'count') {
        const texts = Array.isArray(message.args?.texts) ? message.args.texts : []
        return { ok: true, value: { counts: texts.map((text) => Math.max(1, Math.ceil(String(text).length / 4))) } }
      }
      if (message.port === 'token-estimate' && message.method === 'version') {
        return { ok: true, value: { version: 'v1' } }
      }
      if (message.port === 'budget' && message.method === 'model') {
        return {
          ok: true,
          value: {
            budget: 128000 - 4096 - 1024,
            context_window: 128000,
            max_output: 4096,
            margin: 1024,
            origin: 'default',
            flags: [],
            quota: { l2: 0, l1: 0, skill: 0, recall: 0, style: 0 },
          },
        }
      }
      if (message.port === 'budget' && message.method === 'factor') {
        return { ok: true, value: { factor: 1 } }
      }
      if (message.port === 'budget' && message.method === 'observe') {
        return { ok: true, value: { factor: 1, usage: null } }
      }
      return { ok: false, code: 'not_loaded', message: `${message.port}.${message.method}` }
    },
  })
  return { service, stateDir }
}

function forwardValue(service) {
  return (args, message) =>
    service.call(message.port, message.method, args, message.env).then((frame) => {
      if (frame.kind === 'error') throw new Error(`${frame.error}: ${frame.message}`)
      return frame.value
    })
}

test('消费向：真实 context-window 消费夹具 assemble bag（原生 tokenizer）', async () => {
  const { service: context, stateDir } = startContext()
  try {
    await context.hello()
    const frame = await context.call('context', 'build', clone(nodeIo['context.assemble'].input), FIXED_ENV)
    assert.equal(frame.kind, 'result', `${JSON.stringify(frame)} stderr=${context.stderr.join('')}`)
    const value = frame.value
    assert.equal(value.ok, true, JSON.stringify(value))
    assert.ok(Array.isArray(value.messages), '须返回消息数组')
    assert.ok(value.manifest && typeof value.manifest.used === 'number', '须返回组装清单与用量')
    assert.equal(typeof value.params.model, 'string')
  } finally {
    await stopRealService(context)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('双向：真实 loop-policy ↔ 真实 context-window（消息数组 + 参数 + 用量）', async () => {
  const { service: context, stateDir } = startContext()
  const seen = []
  const loop = startLoop({
    providers: {
      ...defaultProviders({
        'model.chat': (args) => {
          seen.push(args)
          const last = Array.isArray(args.messages) ? args.messages[args.messages.length - 1] : null
          if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: { total_tokens: 7 } }
          return { ok: true, text: 'hello', tool_calls: [], usage: { total_tokens: 5 } }
        },
      }),
      'context.build': (args, message) => {
        // 断言消费的是真实 loop-policy 装配的 bag（而非测试自造）。
        assert.equal(typeof args.config.model, 'string')
        assert.ok('input' in args, 'loop-policy 装配的 bag 须含 input')
        return forwardValue(context)(args, message)
      },
    },
  })
  try {
    await context.hello()
    const result = await loop.interpret(clone(interpretBag))
    assert.equal(result.kind, 'result', JSON.stringify(result))
    // loop-policy 侧：真实 context 输出被消费（模型拿到消息数组），且用量随回帧可用。
    assert.ok(seen.length > 0, '模型调用须消费 context 输出的消息数组')
    const messages = seen[0].messages
    assert.ok(Array.isArray(messages) && messages.length > 0, '消息数组非空')
    assert.equal(messages[0].role, 'system', '前缀系统提示来自 context 组装')
    // 参数对齐：context 算出的 max_output 接进模型 config.params.max_tokens。
    assert.equal(typeof seen[0].config.params.max_tokens, 'number')
    // context 确被真实调用。
    const called = loop.portCalls.filter((call) => call.port === 'context' && call.method === 'build')
    assert.equal(called.length >= 1, true)
  } finally {
    loop.close()
    await loop.exit
    // context-window 把原生 tokenizer 物化进 stateDir；子进程未退出前该 .node 仍被映射，
    // Windows 上会令 rmSync 报 EPERM，故必须先等真实服务退出再清理。
    await stopRealService(context)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('双向：question 作答后，续跑模型经真实 context-window 须看到答案（生产投影路径）', async () => {
  const { service: context, stateDir } = startContext()
  const seen = []
  const loop = startLoop({
    providers: {
      ...defaultProviders({
        'model.chat': (args) => {
          seen.push(clone(args))
          const messages = Array.isArray(args.messages) ? args.messages : []
          const sawAnswer = JSON.stringify(messages).includes('selected')
          // 第一次：没有工具结果 → 发 question；之后一旦见到工具结果 → 收口。
          const hasTool = messages.some((message) => message && message.role === 'tool')
          if (!hasTool)
            return {
              ok: true,
              text: '先确认一下',
              tool_calls: [{ id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: '过没过？', options: [{ label: '过' }, { label: '没过' }] }] } }],
              usage: { total_tokens: 5 },
            }
          return { ok: true, text: sawAnswer ? '收到：过' : '仍未收到答案', tool_calls: [], usage: { total_tokens: 7 } }
        },
      }),
      'context.build': (args, message) => forwardValue(context)(args, message),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) =>
          call.tool === 'question'
            ? { call_id: call.call_id, ok: true, result: { status: 'pending' } }
            : { call_id: call.call_id, ok: true, result: {} },
        ),
      }),
    },
  })
  try {
    await context.hello()
    const first = await loop.interpret({ turn_id: 't1', input: { content: '测一下提问' } })
    assert.equal(first.kind, 'result', JSON.stringify(first))
    const cursor = loop.portCalls.find((call) => call.port === 'tools' && call.method === 'dispatch')?.args?.cursor
    assert.ok(cursor, 'question 派发应带续跑游标')
    const second = await loop.interpret({
      turn_id: 't1',
      input: { content: '测一下提问' },
      resume: { cursor, thread: 't1', payload: { answers: [{ question_id: 'x', selected: ['过'] }] } },
    })
    assert.equal(second.kind, 'result', JSON.stringify(second))
    const last = seen.at(-1)
    assert.ok(last, '续跑须再调模型')
    const toolMessage = (last.messages ?? []).find((message) => message && message.role === 'tool')
    assert.ok(toolMessage, `续跑模型须看到 question 工具结果：${JSON.stringify(last.messages)}`)
    assert.ok(String(toolMessage.content).includes('selected'), '工具结果须含用户作答')
  } finally {
    loop.close()
    await loop.exit
    await stopRealService(context)
    rmSync(stateDir, { recursive: true, force: true })
  }
})
