// `semantic` 的真实模型集成测试（默认不跑）：
// 仅当显式设置 `CHRONO_REAL_MODEL=1` 时才做真实调用——否则 t.skip，避免把「无 key / 无网」误当通过。
// 读仓库根 `.env`（`base_url:` 一行 + 若干 `model_id:` 行），把 semantic 的 `model.chat` 反向调用
// 转发到真实 model-protocol 服务。开启 opt-in 后：`.env` 缺配置可跳过；一旦调用，
// 传输 / 模型错误与空产出都**必须失败**，不再静默跳过。绝不硬编码密钥（本仓库测试模型无需 key）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createFrameDecoder, encodeFrame } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const MP_ROOT = join(REPO_ROOT, 'plugins', 'model-protocol')
const MP_ENTRY = join(MP_ROOT, 'execute', 'main.ts')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const OPT_IN = process.env.CHRONO_REAL_MODEL === '1'
const REAL_ENV = { run: 'real', thread: null, now: Date.now() }

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

/** 通用协议客户端：spawn 一个 stdio 服务，发 call 帧并收 result / error。 */
function startProtocol(entry, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  })
  const decoder = createFrameDecoder()
  const pending = new Map()
  const stderr = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      } else if (message.kind === 'port.call') {
        onPortCall?.(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))
  let onPortCall = null
  let seq = 0
  function call(port, method, args, timeoutMs = 90000) {
    seq += 1
    const id = `t-${seq}`
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectCall(new Error(`timeout waiting ${port}.${method}; stderr=${stderr.join('')}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolveCall(message)
      })
      child.stdin.write(
        encodeFrame({ v: '1', id, kind: 'call', port, method, args, env: REAL_ENV }),
      )
    })
  }
  return {
    child,
    exit,
    call,
    close: () => child.stdin.end(),
    set onPortCall(handler) {
      onPortCall = handler
    },
  }
}

test('semantic 经真实模型服务出记录（默认跳过；CHRONO_REAL_MODEL=1 才跑，失败即失败）', async (t) => {
  if (!OPT_IN) {
    t.skip('未设置 CHRONO_REAL_MODEL=1，跳过真实模型集成测试')
    return
  }
  const env = readDotEnv()
  if (env.base_url.length === 0 || env.model_id.length === 0) {
    t.skip('仓库根 .env 缺少 base_url / model_id')
    return
  }
  const mp = startProtocol(MP_ENTRY, MP_ROOT)
  const svc = startProtocol(ENTRY, PKG_ROOT)
  svc.onPortCall = async (message) => {
    const response = await mp.call(message.port, message.method, message.args)
    const frame =
      response.kind === 'result'
        ? { v: '1', id: message.id, kind: 'port.result', ok: true, value: response.value }
        : {
            v: '1',
            id: message.id,
            kind: 'port.error',
            ok: false,
            error: response.code ?? 'model_error',
            message: response.message ?? '',
          }
    svc.child.stdin.write(encodeFrame(frame))
  }
  try {
    const result = await svc.call('semantic', 'summarize', {
      args: {
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
          {
            role: 'user',
            content: 'Chrono 是一个插件化 agent 运行时，插件以身份入世，能力经 pins 路由。',
          },
          { role: 'assistant', content: '收到，我会据此压缩。' },
        ],
      },
      existing_l1: { goal: '既有目标', facts: ['既有事实'] },
    })
    assert.equal(result.kind, 'result', `真实模型调用未回 result：${JSON.stringify(result)}`)
    assert.equal(
      result.value.summary !== undefined,
      true,
      `真实模型回包缺 summary：${JSON.stringify(result.value)}`,
    )
    assert.ok(
      typeof result.value.summary.goal === 'string' && result.value.summary.goal.length > 0,
      '真实模型应产出非空 goal',
    )
  } finally {
    svc.close()
    mp.close()
  }
})
