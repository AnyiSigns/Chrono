// 端口调用 / 事件记录器 + 权威会话历史读取。
// 事件经客户端 `onEvent`（宿主广播）；历史经 `chat.history` 只读命令取 session owner 自存储；
// 效果审计经客户端 `audit` 取宿主持久审计（反向 `port.call` 只住宿主内存，分离进程启动不可读，见 README 说明）。

/** 取一次 run 结果里最后一个 eval 观测的值（命令 / 只读查询的返回值落在此）。 */
export function lastEvalValue(result) {
  for (let i = result.observations.length - 1; i >= 0; i--) {
    const observation = result.observations[i]
    if (observation !== null && typeof observation === 'object' && observation.kind === 'eval' && 'value' in observation) {
      return observation.value
    }
  }
  return null
}

/** 会话历史窗口压平为消息体数组（newest→oldest 顺序即 store.history 的返回序）。 */
export function historyMessages(history) {
  if (history === null || !Array.isArray(history.messages)) return []
  return history.messages.map((entry) => (entry !== null && typeof entry === 'object' ? entry.def : null)).filter(Boolean)
}

/** 一次 run 结果里全部 extern 观测的载荷（错误值 / 计划透传值都在此）。 */
export function externPayloads(result) {
  return result.observations
    .filter((observation) => observation !== null && typeof observation === 'object' && observation.kind === 'extern')
    .map((observation) => observation.payload)
}

/** 消息里的工具卡 parts。 */
export function toolParts(message) {
  return Array.isArray(message?.parts) ? message.parts.filter((part) => part?.type === 'tool') : []
}

/** 工具调用应答：若模型桩收到含 `hasToolResult` 的消息则回文本，否则在带工具时回一次工具调用。 */
export function toolCallResponder(options = {}) {
  const tool = options.tool ?? 'read'
  const args = options.args ?? { path: 'src/foo.ts' }
  const afterToolText = options.afterToolText ?? 'final'
  const plainText = options.plainText ?? 'plain'
  return (body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : []
    if (messages.some((message) => message && message.role === 'tool')) return { type: 'text', text: afterToolText }
    if (Array.isArray(body?.tools) && body.tools.length > 0) {
      return { type: 'tool_calls', calls: [{ id: 'call-1', name: tool, arguments: args }] }
    }
    return { type: 'text', text: plainText }
  }
}

export function createRecorder(client) {
  const events = []
  client.onEvent((event) => {
    events.push({ at: Date.now(), impl: event.impl, topic: event.topic, payload: event.payload })
  })

  function byTopic(topic) {
    return events.filter((event) => event.topic === topic)
  }

  return {
    events,
    byTopic,
    clearEvents() {
      events.length = 0
    },
    // 等待上限与 boot / ready / loaded 的量级一致：加载中的机器上，一次真实回合的启动
    // 可能显著晚于空闲时，30s 默认会把「慢」误报成「失败」。
    async waitForEvent(topic, timeoutMs = 180_000) {
      const existing = byTopic(topic)
      if (existing.length > 0) return existing[existing.length - 1]
      const deadline = Date.now() + timeoutMs
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        const found = byTopic(topic)
        if (found.length > 0) return found[found.length - 1]
        if (Date.now() > deadline) throw new Error(`timeout waiting for event ${topic}`)
      }
    },
    /** 写输入槽（走 input.write 命令）。 */
    async writeSlot(thread, slot) {
      return client.command('input.write', { thread, slot })
    },
    /** 读输入槽（走 input.read 只读命令）。 */
    async readSlot(thread) {
      return lastEvalValue(await client.command('input.read', { thread }))
    },
    /** 发一回合：先写槽再 chat.send。 */
    async sendTurn(text, options = {}) {
      const thread = options.thread ?? 't1'
      const slot = {
        kind: 'chat.message',
        text,
        workspace_id: options.workspaceId ?? 'w-e2e',
      }
      if (options.conversationId !== undefined) slot.conversation_id = options.conversationId
      await this.writeSlot(thread, slot)
      const result = await client.command('chat.send', null, { thread })
      return { result, slot }
    },
    /**
     * 权威会话历史（session owner 自存储经 chat.history 只读命令读出）。
     * 默认 `full: true`（引擎切片）：`turns[].steps` 是端到端断言（意图 / 结果 / 检查点步）的依据，
     * 展示窗口默认不背步记录。只要消息窗口的用例可传 `{ full: false }`。
     */
    async history(conversation, options = {}) {
      const args = { conversation, full: options.full !== false }
      if (options.before !== undefined) args.before = options.before
      if (options.limit !== undefined) args.limit = options.limit
      return lastEvalValue(await client.command('chat.history', args))
    },
    async audit(filter) {
      return client.audit(filter)
    },
  }
}
