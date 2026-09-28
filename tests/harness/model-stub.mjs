// 可脚本化的模型厂商 HTTP 桩：只按线协议回包，不依赖 `model-protocol` 内部实现。
// 支持场景（按请求依次取脚本，脚本缺省回纯文本）：纯文本 / 工具调用 / 推理 / 任意流式分片序列 /
// 长静默 / 连接失败 / HTTP 错误。流式走 `data: <json>\n\n` + `[DONE]`（openai-chat SSE）。

import { createServer } from 'node:http'

/** 单个脚本响应规格。 */
// {type:'text', text, usage?, delayMs?} | {type:'tool_calls', calls, text?, usage?, delayMs?}
// | {type:'reasoning', reasoning, text?, usage?} | {type:'stream', events:[…]}
// | {type:'silence', ms?} | {type:'connection_failure'} | {type:'http_error', status?, body?}
// `delayMs`：延迟给定毫秒后才产出响应体（模拟「慢但仍在推进」的内层调用）。

function chunk(choices, extra = {}) {
  return JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices, ...extra })
}

function sse(data) {
  return `data: ${data}\n\n`
}

function usageOf(response, body) {
  if (response.usage !== undefined) return response.usage
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const prompt = messages.reduce((total, m) => total + (typeof m?.content === 'string' ? m.content.length : 0), 0)
  return { prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1 }
}

/** 按脚本规格构造 SSE 事件数组（不含收尾 [DONE]）。 */
function streamEvents(response, body) {
  if (response.type === 'stream') return response.events.map((event) => chunk(event.choices ?? [], event.extra ?? {}))
  const events = []
  if (response.type === 'reasoning') {
    for (const piece of String(response.reasoning ?? '').match(/.{1,8}/gs) ?? []) {
      events.push(chunk([{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }]))
    }
  }
  if (response.type === 'tool_calls') {
    const calls = Array.isArray(response.calls) ? response.calls : []
    calls.forEach((call, index) => {
      events.push(
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id ?? `call-${index}`,
                  function: { name: call.name ?? '', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ]),
      )
      const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
      for (const piece of args.match(/.{1,12}/gs) ?? []) {
        events.push(
          chunk([
            {
              index: 0,
              delta: { tool_calls: [{ index, function: { arguments: piece } }] },
              finish_reason: null,
            },
          ]),
        )
      }
    })
    events.push(chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]))
  }
  const text = response.type === 'text' ? String(response.text ?? '') : response.text ?? ''
  for (const piece of String(text).match(/.{1,8}/gs) ?? []) {
    events.push(chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]))
  }
  if (response.type === 'text' || response.type !== 'tool_calls') {
    events.push(chunk([{ index: 0, delta: {}, finish_reason: response.finish_reason ?? 'stop' }]))
  }
  events.push(chunk([], { usage: usageOf(response, body) }))
  return events
}

/** 非流式完整回包（`model.complete` / title 用）。 */
function fullResponse(response, body) {
  const text = response.type === 'tool_calls' ? String(response.text ?? '') : String(response.text ?? response.reasoning ?? '')
  return {
    id: 'stub',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: usageOf(response, body),
  }
}

/**
 * 起桩。`responder(body, index)` 返回脚本规格；未设置时回缺省纯文本 `defaultText`。
 * 返回句柄：`url`（指向 base_url）/ `requests`（收到的请求体）/ `close()`。
 */
export function startModelStub(options = {}) {
  const requests = []
  const aborted = []
  let responder = options.responder ?? null
  const defaultText = options.defaultText ?? 'stub-answer'

  const server = createServer((req, res) => {
    const parts = []
    req.on('data', (part) => parts.push(part))
    req.on('end', () => {
      let body = null
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      } catch {
        body = null
      }
      const index = requests.length
      requests.push(body)
      const scripted = responder !== null ? responder(body, index) : null
      const spec = scripted ?? { type: 'text', text: defaultText }
      // 连接在响应写完前关闭即记为中止（客户端销毁请求）：取消链的可观测证据。
      res.on('close', () => {
        if (!res.writableEnded && spec.type !== 'connection_failure') aborted.push(index)
      })
      /** 可选的 `delayMs`：在给定延迟后才产出响应体（模拟慢但仍在推进的内层调用）。 */
      const respond = () => {
        if (spec.type === 'connection_failure') {
          req.socket.destroy()
          return
        }
        if (spec.type === 'http_error') {
          res.writeHead(spec.status ?? 500, { 'content-type': 'application/json' })
          res.end(JSON.stringify(spec.body ?? { error: { message: 'stub http error' } }))
          return
        }
        const wantsStream = body !== null && body.stream === true
        if (spec.type === 'silence') {
          const timer = setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.end()
          }, spec.ms ?? 60_000)
          res.on('close', () => clearTimeout(timer))
          return
        }
        if (!wantsStream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(fullResponse(spec, body)))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        for (const event of streamEvents(spec, body)) res.write(sse(event))
        res.write(sse('[DONE]'))
        res.end()
      }
      const delayMs = typeof spec.delayMs === 'number' ? spec.delayMs : 0
      if (delayMs > 0) {
        const timer = setTimeout(respond, delayMs)
        res.on('close', () => clearTimeout(timer))
        return
      }
      respond()
    })
  })

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

  return {
    requests,
    /** 在响应写完前被客户端关闭的请求下标（取消链证据）。 */
    aborted,
    get port() {
      return server.address()?.port ?? null
    },
    get url() {
      const address = server.address()
      return address === null ? null : `http://127.0.0.1:${address.port}`
    },
    ready: listening,
    setResponder(fn) {
      responder = fn
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
