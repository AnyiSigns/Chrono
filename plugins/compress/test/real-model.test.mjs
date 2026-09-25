// `compress` semantic 模式的真实模型集成测试（默认不跑）：
// 仅当显式设置 `CHRONO_REAL_MODEL=1` 时才做真实调用——否则 t.skip，避免把「无 key / 无网」误当通过。
// 读仓库根 `.env`（`base_url:` 一行 + 若干 `model_id:` 行），把 compress 的 `model.chat` 反向调用
// 转发到真实 model-protocol 服务。开启 opt-in 后：`.env` 缺配置可跳过；一旦调用，
// 传输 / 模型错误与空产出都**必须失败**，不再静默跳过。绝不硬编码密钥（本仓库测试模型无需 key）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createDecoder, encodeFrame, startService } from './driver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const MP_ROOT = join(REPO_ROOT, 'plugins', 'model-protocol')
const MP_ENTRY = join(MP_ROOT, 'execute', 'main.ts')
const OPT_IN = process.env.CHRONO_REAL_MODEL === '1'

/** 解析 `key:value` 形式的 `.env`；缺失返回空值。 */
function readDotEnv() {
  const file = join(REPO_ROOT, '.env')
  if (!existsSync(file)) return { base_url: '', model_id: [] }
  const baseUrl = []
  const modelId = []
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const index = line.indexOf(':')
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key === 'base_url') baseUrl.push(value)
    else if (key === 'model_id') modelId.push(value)
  }
  return { base_url: baseUrl[0] ?? '', model_id: modelId }
}

/** 拉起真实 model-protocol 服务，供反向调用转发。 */
function startModelProtocol() {
  const child = spawn(process.execPath, [MP_ENTRY], { cwd: MP_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  let seq = 0
  function call(method, args) {
    seq += 1
    const id = `mp-${seq}`
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectCall(new Error('model-protocol timeout'))
      }, 60000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolveCall(message)
      })
      child.stdin.write(
        encodeFrame({ v: '1', id, kind: 'call', port: 'model', method, args, env: { run: 'real', thread: null, now: Date.now() } }),
      )
    })
  }
  return { child, call, close: () => child.stdin.end() }
}

test('semantic 模式经真实模型服务出摘要（默认跳过；CHRONO_REAL_MODEL=1 才跑，失败即失败）', async (t) => {
  if (!OPT_IN) {
    t.skip('未设置 CHRONO_REAL_MODEL=1，跳过真实模型集成测试')
    return
  }
  const env = readDotEnv()
  if (env.base_url.length === 0 || env.model_id.length === 0) {
    t.skip('仓库根 .env 缺少 base_url / model_id')
    return
  }
  const mp = startModelProtocol()
  const drv = startService({
    timeoutMs: 90000,
    bridge: async (port, method, args) => {
      if (port === 'model') {
        const response = await mp.call(method, args)
        if (response.kind === 'result') return { value: response.value }
        return { error: response.code ?? 'model_error', message: response.message ?? '' }
      }
      // 向量化服务不在本用例范围：回错误让去重回落文本路径。
      return { error: 'embedding_unavailable', message: 'real-model test skips embedding' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('summarize', {
      conversation: 'c-real',
      mode: 'semantic',
      model_config: {
        base_url: env.base_url,
        model: env.model_id[0],
        params: { temperature: 0, max_tokens: 2048 },
        quirks: {
          impl: 'protocol',
          protocol: 'openai-chat',
          auth_style: 'bearer',
          system_role: 'system',
          max_tokens_field: 'max_tokens',
          stream_usage: 'final_chunk',
          extra_headers: {},
        },
      },
      session_slice: [
        { role: 'user', content: 'Chrono 是一个插件化 agent 运行时，插件以身份入世，能力经 pins 路由。' },
        { role: 'assistant', content: '收到，我会据此压缩。' },
      ],
    })
    const payload = result.value
    assert.equal(result.kind, 'result', `真实模型调用未回 result：${JSON.stringify(result)}`)
    assert.notEqual(payload, null, `真实模型回包缺 payload：${JSON.stringify(result.value)}`)
    assert.equal(payload.ok, true, `真实模型调用失败（不得静默跳过）：${JSON.stringify(result.value)}`)
    assert.equal(payload.kind, 'summarize')
    assert.ok(payload.summary.goal.length > 0, '真实模型应产出非空 goal')
  } finally {
    drv.close()
    mp.close()
  }
})
