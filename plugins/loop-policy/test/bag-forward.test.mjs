// 生产者接线：最近一次模型用量转发进 context.build bag（估学校准），context.build 的缓存提示
// 原样转发进 model.chat bag。两者都 absent-safe：来源缺失时不落键。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

function contextBuilds(service) {
  return service.portCalls.filter((call) => call.port === 'context' && call.method === 'build').map((call) => call.args)
}

function modelChats(service) {
  return service.portCalls.filter((call) => call.port === 'model' && call.method === 'chat').map((call) => call.args)
}

/** 一条带用量的历史 step.result（段续跑据此重建 last_usage）。 */
function usageStep(usage) {
  return { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: 'prior' }, usage }
}

test('usage 转发：最近一次 step.result 用量随 context.build 下传', async () => {
  const service = startService()
  try {
    await service.interpret({
      turn_id: 't1',
      resume: { continuation: true, turn_id: 't1' },
      session: { turns: [{ turn_id: 't1', steps: [usageStep({ prompt_tokens: 42, completion_tokens: 3 })] }] },
    })
    const builds = contextBuilds(service)
    assert.ok(builds.length >= 1, '应至少组装一次上下文')
    assert.deepEqual(builds[0].usage, { prompt_tokens: 42, completion_tokens: 3 })
  } finally {
    service.close()
  }
})

test('usage absent-safe：无历史用量时 context.build bag 不落 usage 键', async () => {
  const service = startService()
  try {
    await service.interpret({ turn_id: 't1' })
    const builds = contextBuilds(service)
    assert.ok(builds.length >= 1)
    assert.equal(Object.hasOwn(builds[0], 'usage'), false)
  } finally {
    service.close()
  }
})

test('cache 转发：context.build 的缓存提示原样进 model.chat bag', async () => {
  const hint = { breakpoints: [2], system: true, key: 'thread-1' }
  const service = startService({
    providers: {
      'context.build': (args) => ({
        messages: [{ role: 'user', content: 'hello' }],
        params: { model: args.config?.model ?? 'stub' },
        manifest: { dropped: 0 },
        cache: hint,
      }),
    },
  })
  try {
    await service.interpret({ turn_id: 't1' })
    const chats = modelChats(service)
    assert.ok(chats.length >= 1, '应调用模型')
    assert.deepEqual(chats[0].cache, hint)
  } finally {
    service.close()
  }
})

test('cache absent-safe：context.build 无缓存提示时 model.chat bag 不落 cache 键', async () => {
  const service = startService()
  try {
    await service.interpret({ turn_id: 't1' })
    const chats = modelChats(service)
    assert.ok(chats.length >= 1)
    assert.equal(Object.hasOwn(chats[0], 'cache'), false)
  } finally {
    service.close()
  }
})
