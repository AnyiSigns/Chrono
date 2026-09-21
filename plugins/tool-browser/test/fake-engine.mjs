// 测试用假引擎与假反向调用通道。
// 假引擎在内存里维护一个最小页面状态，覆盖全部 action；假 link 应答 sandbox.capabilities 与 host.asset.put。
// 本模块同时是 `CHRONO_BROWSER_ENGINE_MODULE` 注入点（导出 createEngine），供协议测试与 E2E 使用。

import { createHash } from 'node:crypto'
import { ToolError } from '../execute/types.ts'

function requirePresent(state, selector) {
  if (!state.present.has(selector)) {
    throw new ToolError('element_not_found', `selector not found: ${selector}`)
  }
}

/** 造一个假引擎：记录调用、维护页面状态、按选项注入失败。 */
export function makeFakeEngine(options = {}) {
  const calls = []
  const state = {
    url: 'about:blank',
    title: '',
    status: 200,
    text: options.text ?? 'hello body',
    attributes: options.attributes ?? { '#a': { href: '/a' } },
    present: new Set(options.present ?? ['body', '#a', '#submit', 'input']),
    closed: false,
  }
  return {
    calls,
    state,
    async navigate(url, waitUntil) {
      calls.push({ op: 'navigate', url, waitUntil })
      if (options.failNavigate !== undefined) throw new ToolError('navigate_failed', options.failNavigate)
      state.url = url
      state.status = options.status ?? 200
      if (state.status >= 400) throw new ToolError('http_status', `HTTP ${state.status}`)
      state.title = options.title ?? `title:${url}`
      return { status: state.status, url, title: state.title }
    },
    async click(selector) {
      calls.push({ op: 'click', selector })
      requirePresent(state, selector)
      state.clicked = selector
    },
    async type(selector, text, submit) {
      calls.push({ op: 'type', selector, text, submit })
      requirePresent(state, selector)
      state.typed = text
      if (submit === true) state.submitted = true
    },
    async press(key) {
      calls.push({ op: 'press', key })
      state.pressed = key
    },
    async waitFor(selector, ms) {
      calls.push({ op: 'wait_for', selector, ms })
      if (typeof selector === 'string') requirePresent(state, selector)
      if (typeof ms === 'number') state.waited = ms
    },
    async extract(selector, attr) {
      calls.push({ op: 'extract', selector, attr })
      const target = selector ?? 'body'
      if (typeof attr === 'string') {
        const attrs = state.attributes[target]
        if (attrs === undefined || attrs[attr] === undefined) {
          throw new ToolError('element_not_found', `attribute ${attr} not found on ${target}`)
        }
        return { value: attrs[attr] }
      }
      requirePresent(state, target)
      return { text: target === 'body' ? state.text : `text:${target}` }
    },
    async screenshot(fullPage, format) {
      calls.push({ op: 'screenshot', fullPage, format })
      const type = format ?? 'png'
      return {
        bytes: Buffer.from(`fake-image:${fullPage ? 'full' : 'viewport'}:${type}`),
        mime: type === 'jpeg' ? 'image/jpeg' : 'image/png',
      }
    },
    kill() {
      calls.push({ op: 'kill' })
      state.killed = true
    },
    async close() {
      calls.push({ op: 'close' })
      state.closed = true
    },
  }
}

/** 环境变量注入点：`CHRONO_BROWSER_ENGINE_MODULE` 指向本模块时按配置造假引擎。 */
export async function createEngine(_config) {
  return makeFakeEngine()
}

/** 造一个假反向调用通道：默认应答 capabilities 与 asset.put，可注入错误。 */
export function makeFakeLink(options = {}) {
  const calls = []
  return {
    calls,
    async call(port, method, args) {
      calls.push({ port, method, args })
      if (port === 'sandbox' && method === 'capabilities') {
        if (options.sandboxError !== undefined) throw options.sandboxError
        return (
          options.capabilities ?? {
            platform: 'test',
            implementations: [],
            default_impl: 'native',
            enforcement: { fsop: 'in_process', exec_fs: 'none', net: 'declaration' },
          }
        )
      }
      if (port === 'host' && method === 'asset.put') {
        if (options.assetError !== undefined) throw options.assetError
        if (options.asset !== undefined) return options.asset
        const bytes = Buffer.from(args.bytes, 'base64')
        return {
          kind: 'asset',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mime: args.mime,
          size: bytes.length,
        }
      }
      throw new ToolError('unresolved_cap', `no fake handler for ${port}.${method}`)
    },
  }
}
