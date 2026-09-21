// `invoke` 分派与结果形状测试：九个 action、会话生命周期、确定性 id、截图资产、错误透传。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { invoke } from '../execute/invoke.ts'
import { SessionManager } from '../execute/sessions.ts'
import { BrowserUnsupportedError } from '../execute/engine/types.ts'
import { ToolError } from '../execute/types.ts'
import { makeFakeEngine, makeFakeLink } from './fake-engine.mjs'

const CONFIG = {
  impl: 'fake',
  headless: true,
  browserPath: null,
  viewport: { width: 800, height: 600 },
  navigationTimeoutMs: 1000,
  actionTimeoutMs: 1000,
  screenshotFormat: 'png',
  allowDownload: false,
  stateDir: null,
}

function makeCtx(options = {}) {
  const engines = []
  const factory =
    options.factory ??
    (async () => {
      const engine = makeFakeEngine(options.engine)
      engines.push(engine)
      return engine
    })
  const sessions = new SessionManager(factory, CONFIG, options.idleMs ?? 10000)
  const link = makeFakeLink(options.link)
  return { ctx: { sessions, link }, engines, link }
}

const env = (now = 0, run = 'run-1') => ({ run, thread: null, now })
const bag = (args, extra = {}) => ({ tool: 'webbrowser', args, tier: 'auto', caps: { net: 'all' }, ...extra })

test('九个 action 的分派与结果形状', async () => {
  const { ctx, link } = makeCtx()
  const opened = await invoke(bag({ action: 'open' }), ctx, env())
  assert.equal(opened.ok, true)
  const session = opened.result.session

  const navigate = await invoke(bag({ action: 'navigate', session, url: 'https://example.com' }), ctx, env())
  assert.deepEqual(navigate.result, { status: 200, url: 'https://example.com', title: 'title:https://example.com' })
  assert.deepEqual((await invoke(bag({ action: 'click', session, selector: '#a' }), ctx, env())).result, { ok: true })
  assert.deepEqual((await invoke(bag({ action: 'type', session, selector: 'input', text: 'hi', submit: true }), ctx, env())).result, { ok: true })
  assert.deepEqual((await invoke(bag({ action: 'press', session, key: 'Enter' }), ctx, env())).result, { ok: true })
  assert.deepEqual((await invoke(bag({ action: 'wait_for', session, selector: '#a' }), ctx, env())).result, { ok: true })
  assert.deepEqual((await invoke(bag({ action: 'extract', session }), ctx, env())).result, { text: 'hello body' })
  assert.deepEqual((await invoke(bag({ action: 'extract', session, selector: '#a', attr: 'href' }), ctx, env())).result, { value: '/a' })

  const shot = await invoke(bag({ action: 'screenshot', session }), ctx, env())
  assert.equal(shot.ok, true)
  assert.equal(shot.result.asset.kind, 'asset')
  assert.equal(shot.result.asset.mime, 'image/png')
  assert.match(shot.result.asset.sha256, /^[0-9a-f]{64}$/)
  assert.ok(shot.result.asset.size > 0)
  assert.ok(link.calls.some((call) => call.port === 'host' && call.method === 'asset.put'))

  assert.deepEqual((await invoke(bag({ action: 'close', session }), ctx, env())).result, { closed: true })
})

test('会话内状态保持：open→navigate→click→extract 用同一引擎实例', async () => {
  const { ctx, engines } = makeCtx()
  const session = (await invoke(bag({ action: 'open' }), ctx, env())).result.session
  await invoke(bag({ action: 'navigate', session, url: 'https://a.test' }), ctx, env(1))
  await invoke(bag({ action: 'click', session, selector: '#a' }), ctx, env(2))
  const extract = await invoke(bag({ action: 'extract', session }), ctx, env(3))
  assert.equal(engines.length, 1)
  assert.equal(extract.result.text, 'hello body')
  const ops = engines[0].calls.map((call) => call.op)
  assert.deepEqual(ops, ['navigate', 'click', 'extract'])
})

test('close 后引用回 session_not_found', async () => {
  const { ctx } = makeCtx()
  const session = (await invoke(bag({ action: 'open' }), ctx, env())).result.session
  await invoke(bag({ action: 'close', session }), ctx, env(1))
  const after = await invoke(bag({ action: 'navigate', session, url: 'https://x.test' }), ctx, env(2))
  assert.equal(after.ok, false)
  assert.equal(after.error.code, 'session_not_found')
})

test('空闲超 TTL 自动回收：后续动作回 session_not_found 且引擎被关闭', async () => {
  const { ctx, engines } = makeCtx({ idleMs: 1000 })
  const session = (await invoke(bag({ action: 'open' }), ctx, env(0))).result.session
  const after = await invoke(bag({ action: 'extract', session }), ctx, env(1001))
  assert.equal(after.error.code, 'session_not_found')
  assert.equal(engines[0].state.closed, true)
})

test('会话 id 确定性：同 run 同序同 id', async () => {
  const first = makeCtx()
  const second = makeCtx()
  const a = (await invoke(bag({ action: 'open' }), first.ctx, env(0, 'run-9'))).result.session
  const b = (await invoke(bag({ action: 'open' }), second.ctx, env(0, 'run-9'))).result.session
  assert.equal(a, b)
})

test('引擎 / 平台不可用 → browser_unsupported', async () => {
  const { ctx } = makeCtx({
    factory: async () => {
      throw new BrowserUnsupportedError('no browser here')
    },
  })
  const opened = await invoke(bag({ action: 'open' }), ctx, env())
  assert.equal(opened.ok, false)
  assert.equal(opened.error.code, 'browser_unsupported')
})

test('net_denied：本插件声明级钳制越档即拒（all 需求下 severe / review / deny 均拒）', async () => {
  const { ctx } = makeCtx()
  for (const tier of ['severe', 'review', 'deny']) {
    const opened = await invoke(bag({ action: 'open' }, { tier }), ctx, env())
    assert.equal(opened.ok, false, `tier=${tier}`)
    assert.equal(opened.error.code, 'net_denied', `tier=${tier}`)
  }
  const auto = await invoke(bag({ action: 'open' }), ctx, env())
  assert.equal(auto.ok, true)
})

test('net_denied 透传：反向调用 sandbox 返回的错误原样回', async () => {
  const { ctx } = makeCtx()
  const session = (await invoke(bag({ action: 'open' }), ctx, env())).result.session
  ctx.link.call = async () => {
    throw new ToolError('net_denied', 'denied by sandbox')
  }
  const after = await invoke(bag({ action: 'navigate', session, url: 'https://x.test' }), ctx, env(1))
  assert.equal(after.error.code, 'net_denied')
  assert.equal(after.error.message, 'denied by sandbox')
})

test('消费 sandbox.capabilities：自述 net 不强制（none）时 fail-closed 拒绝', async () => {
  const { ctx } = makeCtx({ link: { capabilities: { enforcement: { net: 'none' } } } })
  const opened = await invoke(bag({ action: 'open' }), ctx, env())
  assert.equal(opened.ok, false)
  assert.equal(opened.error.code, 'net_denied')

  const declaration = makeCtx({ link: { capabilities: { enforcement: { net: 'declaration' } } } })
  assert.equal((await invoke(bag({ action: 'open' }), declaration.ctx, env())).ok, true)
})

test('引擎错误透传：http_status / element_not_found / navigate_failed', async () => {
  const { ctx } = makeCtx({ engine: { status: 404 } })
  const session = (await invoke(bag({ action: 'open' }), ctx, env())).result.session
  const http = await invoke(bag({ action: 'navigate', session, url: 'https://x.test' }), ctx, env(1))
  assert.equal(http.error.code, 'http_status')

  const missing = await invoke(bag({ action: 'click', session, selector: '#missing' }), ctx, env(2))
  assert.equal(missing.error.code, 'element_not_found')

  const broken = makeCtx({ engine: { failNavigate: 'dns' } })
  const brokenSession = (await invoke(bag({ action: 'open' }), broken.ctx, env())).result.session
  const failed = await invoke(bag({ action: 'navigate', session: brokenSession, url: 'https://x.test' }), broken.ctx, env(1))
  assert.equal(failed.error.code, 'navigate_failed')
})

test('形态非法 → bad_args；未知工具 → unknown_tool', async () => {
  const { ctx } = makeCtx()
  assert.equal((await invoke(null, ctx, env())).error.code, 'bad_args')
  assert.equal((await invoke({ tool: 'nope', args: {} }, ctx, env())).error.code, 'unknown_tool')
  assert.equal((await invoke({ tool: 'webbrowser', args: {} }, ctx, env())).error.code, 'bad_args')
  assert.equal((await invoke(bag({ action: 'nope' }), ctx, env())).error.code, 'bad_args')
  assert.equal((await invoke(bag({ action: 'navigate' }), ctx, env())).error.code, 'bad_args')
  assert.equal((await invoke(bag({ action: 'wait_for' }), ctx, env())).error.code, 'bad_args')
})

test('navigate 危险 / 非 http(s) URL → navigate_failed（不做 host 过滤，只限协议）', async () => {
  const { ctx } = makeCtx()
  const session = (await invoke(bag({ action: 'open' }), ctx, env())).result.session
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/x', 'about:blank']) {
    const result = await invoke(bag({ action: 'navigate', session, url }), ctx, env(1))
    assert.equal(result.ok, false, url)
    assert.equal(result.error.code, 'navigate_failed', url)
  }
})

test('资产面失败码归一：asset_too_large → binary_unsupported，未知码 → tool_failed，已知码透传', async () => {
  const tooLarge = makeCtx({ link: { assetError: new ToolError('asset_too_large', 'over limit') } })
  const tooLargeSession = (await invoke(bag({ action: 'open' }), tooLarge.ctx, env())).result.session
  const tooLargeShot = await invoke(bag({ action: 'screenshot', session: tooLargeSession }), tooLarge.ctx, env(1))
  assert.equal(tooLargeShot.error.code, 'binary_unsupported')

  const weird = makeCtx({ link: { assetError: new ToolError('asset_missing', 'no such asset') } })
  const weirdSession = (await invoke(bag({ action: 'open' }), weird.ctx, env())).result.session
  const weirdShot = await invoke(bag({ action: 'screenshot', session: weirdSession }), weird.ctx, env(1))
  assert.equal(weirdShot.error.code, 'tool_failed')

  const timeout = makeCtx({ link: { assetError: new ToolError('tool_timeout', 'slow host') } })
  const timeoutSession = (await invoke(bag({ action: 'open' }), timeout.ctx, env())).result.session
  const timeoutShot = await invoke(bag({ action: 'screenshot', session: timeoutSession }), timeout.ctx, env(1))
  assert.equal(timeoutShot.error.code, 'tool_timeout')
})
