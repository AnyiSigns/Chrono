// `model-protocol` SDK 路径测试：`impl=sdk` 惰性加载伪 @google/genai 模块（可控注入，不触网）。
// 覆盖请求编解码（maxOutputTokens / thinkingConfig 点路径 / systemInstruction / contents）、
// usage 归一、非流式 complete、包缺失 / 不支持的包名 -> model_unsupported。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startService } from './driver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_SDK = new URL('./fake-google-sdk.mjs', import.meta.url).href

function sdkQuirks() {
  return {
    impl: 'sdk',
    sdk_package: '@google/genai',
    auth_style: 'header',
    auth_header: 'x-goog-api-key',
    system_role: 'system',
    max_tokens_field: 'maxOutputTokens',
    reasoning_field: 'thinkingConfig.thinkingBudget',
    reasoning_map: { low: 128, medium: 1024, high: 4096 },
    models_path: '/models',
    stream_usage: 'final_chunk',
    extra_headers: {},
  }
}

function sdkBag(overrides = {}) {
  const { config, ...rest } = overrides
  return {
    config: {
      base_url: 'https://generativelanguage.googleapis.com',
      auth_ref: { kind: 'local', name: 'GOOGLE_API_KEY' },
      model: 'gemini-test',
      params: { temperature: 0.1, max_tokens: 64, reasoning: 'low' },
      quirks: sdkQuirks(),
      ...config,
    },
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ],
    resilience: { max_retries: 0, backoff_ms: 5, token_bucket: { capacity: 100, refill_per_sec: 1000 } },
    ...rest,
  }
}

async function withService(env, run) {
  const driver = startService({ env: { CHRONO_MODEL_SDK_MODULE: FAKE_SDK, FAKE_GOOGLE_KEY: 'g-key', ...env }, secretsResolver: () => ({ value: 'g-key' }) })
  try {
    await driver.hello()
    return await run(driver)
  } finally {
    driver.close()
    await driver.exit
  }
}

test('impl=sdk：chat 走 SDK 适配器，请求编解码正确（点路径推理 / maxOutputTokens / systemInstruction）', async () => {
  await withService({}, async (driver) => {
    const result = await driver.call('chat', sdkBag())
    assert.equal(result.value.ok, true)
    assert.equal(result.value.protocol, 'sdk')
    const params = JSON.parse(result.value.text)
    assert.equal(params.model, 'gemini-test')
    assert.equal(params.config.maxOutputTokens, 64)
    assert.deepEqual(params.config.thinkingConfig, { thinkingBudget: 128 })
    assert.equal(params.config.systemInstruction, 'be terse')
    assert.equal(params.config.temperature, 0.1)
    assert.equal(params.contents.length, 1)
    assert.equal(params.contents[0].role, 'user')
    assert.deepEqual(result.value.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
    const textEvents = driver.events.filter((event) => event.topic === 'model.delta').map((event) => event.payload.text).filter((value) => typeof value === 'string')
    assert.equal(textEvents.join(''), result.value.text)
  })
})

test('impl=sdk：complete 非流式回 {text, usage}，不发事件', async () => {
  await withService({}, async (driver) => {
    const result = await driver.call('complete', sdkBag())
    assert.deepEqual(result.value, { ok: true, text: 'complete', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    assert.equal(driver.events.length, 0)
  })
})

test('impl=sdk：不支持的 sdk_package / 模块缺失 -> model_unsupported', async () => {
  await withService({}, async (driver) => {
    const unsupported = await driver.call('chat', sdkBag({ config: { quirks: { ...sdkQuirks(), sdk_package: '@other/sdk' } } }))
    assert.equal(unsupported.value.error.code, 'model_unsupported')
  })
  await withService({ CHRONO_MODEL_SDK_MODULE: 'file:///nonexistent/fake-sdk.mjs' }, async (driver) => {
    const missing = await driver.call('chat', sdkBag())
    assert.equal(missing.value.error.code, 'model_unsupported')
  })
})

test('impl=sdk：流断整请求重试，reset 后不重不漏并收终止标记', async () => {
  await withService({ FAKE_GOOGLE_FAIL_TIMES: '1' }, async (driver) => {
    const bag = sdkBag({ resilience: { max_retries: 1, backoff_ms: 5, backoff_max_ms: 20, token_bucket: { capacity: 100, refill_per_sec: 1000 } } })
    const result = await driver.call('chat', bag)
    assert.equal(result.value.ok, true)
    const params = JSON.parse(result.value.text)
    assert.equal(params.model, 'gemini-test')
    const payloads = driver.events.filter((event) => event.topic === 'model.delta').map((event) => event.payload)
    assert.ok(payloads.some((payload) => payload.reset === true), '重试前应上行 reset')
    assert.ok(payloads.some((payload) => payload.done === true), '流结束应上行 done')
    const lastReset = payloads.map((payload) => payload.reset === true).lastIndexOf(true)
    const afterReset = payloads.slice(lastReset + 1).map((payload) => payload.text).filter((value) => typeof value === 'string')
    assert.equal(afterReset.join(''), result.value.text, 'reset 后重放的文本不重不漏')
  })
})
