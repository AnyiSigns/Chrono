// `model-protocol` 方法级测试：discover / profile / sync / vendors。
// 网络一律用本地 HTTP 服务器；models.dev 源用本地 JSON 模拟。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'
import { jsonResponse, startHttpServer } from './fake-http.mjs'

const FAST = { max_retries: 1, backoff_ms: 5, backoff_max_ms: 20, token_bucket: { capacity: 100, refill_per_sec: 1000 } }

async function withService(options, run) {
  const driver = startService(options)
  try {
    await driver.hello()
    return await run(driver)
  } finally {
    driver.close()
    await driver.exit
  }
}

async function withServer(handler, run) {
  const server = await startHttpServer(handler)
  try {
    return await run(server)
  } finally {
    await server.close()
  }
}

function writeDirective(value) {
  return value.$directives.find((item) => item.kind === 'write')
}

function externPayload(value) {
  const extern = value.$directives.find((item) => item.kind === 'extern')
  return extern === undefined ? null : extern.payload
}

function planBody(value) {
  const write = writeDirective(value)
  return write === undefined ? null : write.request.args.ops[0].args.body
}

const MODELS_DEV = {
  deepseek: {
    models: {
      'deepseek-chat': {
        limit: { context: 64000, output: 8000 },
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
      },
      'deepseek-r1': {
        limit: { context: 128000, output: 16000 },
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
}

function baseConfig() {
  return {
    version: 1,
    providers: {
      deepseek: {
        base_url: 'https://api.deepseek.com/v1',
        auth_ref: { kind: 'local', name: 'DEEPSEEK_API_KEY' },
        models: {
          'deepseek-chat': { name: 'DeepSeek Chat', enabled: true, reasoning: ['low'] },
          'deepseek-r1': { name: 'DeepSeek R1', enabled: true, reasoning: ['low', 'high'] },
          untouched: { name: 'Keep', enabled: false },
        },
      },
    },
  }
}

const VENDOR_BODY = {
  sdk: 'deepseek',
  default_base_url: 'https://api.deepseek.com/v1',
  default_auth_ref_name: 'DEEPSEEK_API_KEY',
  default_reasoning: ['low', 'medium', 'high'],
}

// ── discover ───────────────────────────────────────────────────────────────

test('discover：规范化模型 id（去重 / 剥 models/ 前缀 / 排序）并带鉴权头', async () => {
  const handler = (req, res) => jsonResponse(res, 200, { data: [{ id: 'b' }, { id: 'models/a' }, { id: 'b' }] })
  await withServer(handler, async (server) => {
    await withService({ secretsResolver: () => ({ value: 'disc-key' }) }, async (driver) => {
      const result = await driver.call('discover', { url: server.url, auth_ref: { kind: 'env', name: 'K' }, resilience: FAST })
      assert.deepEqual(result.value, { ok: true, models: ['a', 'b'] })
      assert.equal(server.requests[0].url, '/models')
      assert.equal(server.requests[0].headers.authorization, 'Bearer disc-key')
    })
  })
})

test('discover：google 形状（models[].name）也规范化', async () => {
  const handler = (req, res) => jsonResponse(res, 200, { models: [{ name: 'models/gemini-2.0' }, { name: 'models/gemini-1.5' }] })
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('discover', { url: server.url, models_path: '/v1beta/models', resilience: FAST })
      assert.deepEqual(result.value.models, ['gemini-1.5', 'gemini-2.0'])
      assert.equal(server.requests[0].url, '/v1beta/models')
    })
  })
})

test('discover 四类结构化错误', async () => {
  await withService({ secretsResolver: () => ({ error: 'secret_missing', message: 'x' }) }, async (driver) => {
    const auth = await driver.call('discover', { url: 'http://127.0.0.1:1', auth_ref: { kind: 'local', name: 'M' }, resilience: FAST })
    assert.equal(auth.value.error.code, 'discover_auth_failed')
  })
  const statuses = [
    [401, 'discover_auth_failed'],
    [404, 'discover_bad_url'],
    [200, 'discover_unsupported'],
  ]
  for (const [status, code] of statuses) {
    const handler = (req, res) => (status === 200 ? jsonResponse(res, 200, {}) : jsonResponse(res, status, {}))
    await withServer(handler, async (server) => {
      await withService({}, async (driver) => {
        const result = await driver.call('discover', { url: server.url, resilience: FAST })
        assert.equal(result.value.error.code, code, `status ${status}`)
      })
    })
  }
  const dead = await startHttpServer((req, res) => jsonResponse(res, 200, {}))
  const deadUrl = dead.url
  await dead.close()
  await withService({}, async (driver) => {
    const result = await driver.call('discover', { url: deadUrl, resilience: { ...FAST, max_retries: 0 } })
    assert.equal(result.value.error.code, 'discover_network')
  })
})

test('discover：非法 URL 归 discover_bad_url（不冒泡 internal）', async () => {
  await withService({}, async (driver) => {
    const result = await driver.call('discover', { url: 'not a url', resilience: FAST })
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'discover_bad_url')
  })
})

// ── profile ────────────────────────────────────────────────────────────────

test('profile：只写所选模型、布尔 true 展开 default_reasoning、其余模型不动', async () => {
  const handler = (req, res) => jsonResponse(res, 200, MODELS_DEV)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const args = {
        vendor: 'vendor-deepseek',
        ids: ['deepseek-chat', 'deepseek-r1', 'missing'],
        config: baseConfig(),
        vendors: { 'vendor-deepseek': VENDOR_BODY },
        source_url: server.url,
        resilience: FAST,
      }
      const result = await driver.call('profile', args)
      const body = planBody(result.value)
      assert.ok(body !== null, '应产写计划')
      const models = body.providers.deepseek.models
      assert.deepEqual(models['deepseek-chat'].context_window, 64000)
      assert.deepEqual(models['deepseek-chat'].max_output, 8000)
      assert.deepEqual(models['deepseek-chat'].reasoning, ['low', 'medium', 'high'])
      assert.deepEqual(models['deepseek-chat'].modalities, { input: ['text'], output: ['text'] })
      assert.equal(models['deepseek-chat'].name, 'DeepSeek Chat')
      assert.equal(models['deepseek-r1'].reasoning, undefined, '布尔 false 应缺键')
      assert.deepEqual(models.untouched, { name: 'Keep', enabled: false }, '未选模型不动')
      assert.equal(models.missing, undefined, '源里没有的模型不新增')
      assert.equal(body.providers.deepseek.models['deepseek-chat'].enabled, true)

      const ops = writeDirective(result.value).request.args.ops
      assert.deepEqual(ops[1], { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } })
      assert.equal(externPayload(result.value).changed, true)
    })
  })
})

test('profile：写前去重（同 body 再跑只回 extern）', async () => {
  const handler = (req, res) => jsonResponse(res, 200, MODELS_DEV)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const args = {
        vendor: 'deepseek',
        ids: ['deepseek-chat'],
        config: baseConfig(),
        vendors: { 'vendor-deepseek': VENDOR_BODY },
        source_url: server.url,
        resilience: FAST,
      }
      const first = await driver.call('profile', args)
      const updated = planBody(first.value)
      const second = await driver.call('profile', { ...args, config: updated })
      assert.equal(writeDirective(second.value), undefined)
      assert.equal(externPayload(second.value).changed, false)
    })
  })
})

test('profile：未知厂商 / config 缺省 / 源非 JSON', async () => {
  const handler = (req, res) => jsonResponse(res, 200, MODELS_DEV)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const unknown = await driver.call('profile', { vendor: 'nope', ids: ['x'], source_url: server.url, resilience: FAST })
      assert.equal(unknown.value.error.code, 'profile_vendor_unknown')

      const noConfig = await driver.call('profile', { vendor: 'deepseek', ids: ['deepseek-chat'], vendors: { 'vendor-deepseek': VENDOR_BODY }, source_url: server.url, resilience: FAST })
      assert.equal(noConfig.value.ok, true)
      assert.equal(noConfig.value.write, false)
      assert.equal(noConfig.value.models['deepseek-chat'].context_window, 64000)
    })
  })
  const bad = await startHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('not json')
  })
  try {
    await withService({}, async (driver) => {
      const result = await driver.call('profile', {
        vendor: 'deepseek',
        ids: ['deepseek-chat'],
        config: baseConfig(),
        source_url: bad.url,
        resilience: FAST,
      })
      assert.equal(result.value.error.code, 'profile_bad_source')
    })
  } finally {
    await bad.close()
  }
})

// ── sync ───────────────────────────────────────────────────────────────────

test('sync：对 config 内全部已选模型批量刷新，无变化不产写计划', async () => {
  const handler = (req, res) => jsonResponse(res, 200, MODELS_DEV)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const bag = { config: baseConfig(), 'vendor-deepseek': VENDOR_BODY, source_url: server.url, resilience: FAST }
      const first = await driver.call('sync', bag)
      const body = planBody(first.value)
      assert.ok(body !== null)
      assert.deepEqual(body.providers.deepseek.models['deepseek-chat'].reasoning, ['low', 'medium', 'high'])
      assert.equal(body.providers.deepseek.models['deepseek-r1'].reasoning, undefined)
      const second = await driver.call('sync', { ...bag, config: body })
      assert.equal(writeDirective(second.value), undefined)
      assert.equal(externPayload(second.value).changed, false)
    })
  })
})

test('sync：bag 缺 config → 只回 extern、不触网', async () => {
  await withService({}, async (driver) => {
    const result = await driver.call('sync', { resilience: FAST })
    assert.equal(externPayload(result.value).changed, false)
  })
})

// ── vendors ────────────────────────────────────────────────────────────────

test('vendors：枚举传入模板（数组 / 对象 / 顶层 vendor-* 键），按身份排序', async () => {
  await withService({}, async (driver) => {
    const result = await driver.call('vendors', {
      vendors: {
        'vendor-openai': { sdk: 'openai', default_base_url: 'https://api.openai.com/v1', default_auth_ref_name: 'OPENAI_API_KEY', default_reasoning: ['low', 'high'] },
        'vendor-deepseek': VENDOR_BODY,
      },
      'vendor-kimi': { sdk: 'kimi', default_base_url: 'https://api.moonshot.cn/v1', default_auth_ref_name: 'KIMI_API_KEY' },
    })
    assert.equal(result.value.ok, true)
    assert.deepEqual(result.value.vendors.map((item) => item.identity), ['vendor-deepseek', 'vendor-kimi', 'vendor-openai'])
    const openai = result.value.vendors.find((item) => item.identity === 'vendor-openai')
    assert.deepEqual(openai, {
      identity: 'vendor-openai',
      default_base_url: 'https://api.openai.com/v1',
      default_auth_ref_name: 'OPENAI_API_KEY',
      default_reasoning: ['low', 'high'],
    })
    const kimi = result.value.vendors.find((item) => item.identity === 'vendor-kimi')
    assert.equal(kimi.default_reasoning, null)
  })
})

test('vendors：数组形态 [{sdk,...}] 自动派生身份', async () => {
  await withService({}, async (driver) => {
    const result = await driver.call('vendors', { vendors: [{ sdk: 'zai', default_base_url: 'u' }] })
    assert.deepEqual(result.value.vendors, [
      { identity: 'vendor-zai', default_base_url: 'u', default_auth_ref_name: null, default_reasoning: null },
    ])
  })
})
