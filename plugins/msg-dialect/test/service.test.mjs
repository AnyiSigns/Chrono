// `msg-dialect` 服务协议级测试：spawn `node execute/main.ts`。
// 覆盖握手 / 控制 / EOF；normalize-quirks / reasoning-capability / encode-tools / apply-auth / build / parse-full。
// `inline-assets` 的 host 反向调用在 dialect.test.mjs 直接单测（async 取字节不经本同步驱动）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

function drive() {
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT })
  return {
    ...drv,
    hello: () => drv.hello('msg-dialect'),
    call: (method, args, env = FIXED_ENV) => drv.call('msg-dialect', method, args, env),
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'msg-dialect')
    assert.deepEqual(manifest.implements, ['msg-dialect'])
    assert.deepEqual(manifest.methods['msg-dialect'], [
      'normalize-quirks',
      'reasoning-capability',
      'encode-tools',
      'apply-auth',
      'build',
      'parse-full',
      'inline-assets',
    ])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('normalize-quirks / reasoning-capability：纯归一', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const quirks = await drv.call('normalize-quirks', { protocol_override: 'anthropic-messages' })
    assert.equal(quirks.value.quirks.protocol, 'anthropic-messages')
    assert.equal(quirks.value.quirks.auth_style, 'header')

    const capability = await drv.call('reasoning-capability', {
      provider: 'deepseek',
      protocol: 'openai-chat',
    })
    assert.equal(capability.value.capability.replay_form, 'reasoning_content')
  } finally {
    drv.close()
  }
})

test('encode-tools / apply-auth', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const tools = await drv.call('encode-tools', {
      tools: [{ name: 'a', argsSchema: { type: 'object' } }],
      protocol: 'openai-chat',
    })
    assert.deepEqual(tools.value.tools, [
      { type: 'function', function: { name: 'a', parameters: { type: 'object' } } },
    ])

    const auth = await drv.call('apply-auth', {
      url: 'https://x/y',
      quirks: { auth_style: 'bearer', extra_headers: {} },
      secret: 'sk',
    })
    assert.deepEqual(auth.value, { url: 'https://x/y', headers: { authorization: 'Bearer sk' } })
  } finally {
    drv.close()
  }
})

test('build / parse-full', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const quirks = (await drv.call('normalize-quirks', { protocol_override: 'openai-chat' })).value
      .quirks
    const built = await drv.call('build', {
      quirks,
      provider: 'openai',
      base_url: 'https://x/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    assert.equal(built.value.kind, 'http')
    assert.equal(built.value.url, 'https://x/v1/chat/completions')

    const parsed = await drv.call('parse-full', {
      quirks,
      provider: 'openai',
      model: 'm',
      json: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
    })
    assert.equal(parsed.value.text, 'x')
  } finally {
    drv.close()
  }
})

test('args 非法 / 未知方法 → 结构化 error；无事件', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal(
      (await drv.call('normalize-quirks', null)).value.quirks.protocol,
      'openai-chat',
      'null 入参取协议默认',
    )
    assert.equal((await drv.call('build', {})).code, 'bad_args')
    assert.equal((await drv.call('parse-full', { quirks: {}, provider: 'p' })).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'msg-dialect', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'build', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
    assert.equal(drv.events.length, 0)
  } finally {
    drv.close()
  }
})
