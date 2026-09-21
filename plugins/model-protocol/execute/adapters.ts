// 三协议适配器：把归一化的 messages / system / max_tokens 字段 / reasoning 档位·map / 工具编成请求体；
// 把回包解析为 text / reasoning / tool_calls / usage / 停止原因。
// 有界适配器——每个 protocol 一种，厂商差异经 quirks 声明式覆盖。

import { ModelError } from './errors.ts'
import { applyAuth, encodeReasoning, joinUrl, setByPath } from './quirks.ts'
import type { Quirks } from './quirks.ts'
import { asRecord, stringField, StreamAccumulator } from './stream.ts'
import type { Json, Rec } from './types.ts'

export interface RequestContext {
  base_url: string
  model: string
  messages: Json[]
  params: Rec
  quirks: Quirks
  secret: string | null
  stream: boolean
  tools: Json | undefined
  tool_choice: Json | undefined
}

export interface BuiltRequest {
  url: string
  headers: Rec
  body: Rec
}

export interface ModelOutput {
  text: string
  reasoning?: string
  tool_calls: Json[]
  usage: Rec | null
  stop_reason?: string
}

export interface Adapter {
  readonly protocol: string
  build(ctx: RequestContext): BuiltRequest
  /** 解析一条 SSE data 载荷为归一化分片（文本 / 推理 / 工具调用 / 用量 / 停止原因）。 */
  handleStreamData(data: string, acc: StreamAccumulator): Rec[]
  parseFull(json: Json): ModelOutput
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function baseHeaders(quirks: Quirks, accept: string): Rec {
  return { 'content-type': 'application/json', accept, ...quirks.extra_headers }
}

function applyOptional(body: Rec, ctx: RequestContext): void {
  const temperature = ctx.params['temperature']
  if (typeof temperature === 'number') body['temperature'] = temperature
  const maxTokens = ctx.params['max_tokens']
  if (typeof maxTokens === 'number') body[ctx.quirks.max_tokens_field] = maxTokens
  const reasoning = encodeReasoning(ctx.quirks, ctx.params['reasoning'])
  if (reasoning !== null) setByPath(body, reasoning.path, reasoning.value)
  if (ctx.tools !== undefined) body['tools'] = ctx.tools
  if (ctx.tool_choice !== undefined) body['tool_choice'] = ctx.tool_choice
}

function normalizeUsage(prompt: Json | undefined, completion: Json | undefined): Rec | null {
  if (typeof prompt !== 'number' && typeof completion !== 'number') return null
  const promptTokens = typeof prompt === 'number' ? prompt : 0
  const completionTokens = typeof completion === 'number' ? completion : 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

function mapMessages(ctx: RequestContext): Json[] {
  const mapped: Json[] = []
  for (const message of ctx.messages) {
    if (!isRecord(message)) continue
    const role = typeof message['role'] === 'string' ? message['role'] : 'user'
    const entry: Rec = { role: role === 'system' ? ctx.quirks.system_role : role }
    if (message['content'] !== undefined) entry['content'] = message['content']
    if (message['name'] !== undefined) entry['name'] = message['name']
    if (message['tool_call_id'] !== undefined) entry['tool_call_id'] = message['tool_call_id']
    if (message['tool_calls'] !== undefined) entry['tool_calls'] = message['tool_calls']
    mapped.push(entry)
  }
  return mapped
}

function pushFragment(target: Rec[], fragment: Rec | null): void {
  if (fragment !== null) target.push(fragment)
}

function single(fragment: Rec | null): Rec[] {
  return fragment === null ? [] : [fragment]
}

function parseArgs(raw: string | undefined): Json {
  if (raw === undefined || raw.length === 0) return {}
  try {
    return JSON.parse(raw) as Json
  } catch {
    return raw
  }
}

function parseToolCalls(raw: Json | undefined): Json[] {
  if (!Array.isArray(raw)) return []
  const calls: Json[] = []
  for (const item of raw) {
    const call = asRecord(item)
    if (call === null) continue
    const fn = asRecord(call['function']) ?? {}
    calls.push({ id: call['id'] ?? null, name: fn['name'] ?? null, arguments: parseArgs(stringField(fn, 'arguments')) })
  }
  return calls
}

  /** openai-chat：`/chat/completions` + `data:` 分片。 */
class OpenAiChatAdapter implements Adapter {
  readonly protocol = 'openai-chat'
  private readonly reasoningField: string | null

  constructor(quirks: Quirks) {
    this.reasoningField = quirks.reasoning_response_field
  }

  build(ctx: RequestContext): BuiltRequest {
    const body: Rec = { model: ctx.model, messages: mapMessages(ctx), stream: ctx.stream }
    if (ctx.stream && ctx.quirks.stream_usage === 'final_chunk') body['stream_options'] = { include_usage: true }
    applyOptional(body, ctx)
    const headers = baseHeaders(ctx.quirks, ctx.stream ? 'text/event-stream' : 'application/json')
    const auth = applyAuth(joinUrl(ctx.base_url, '/chat/completions'), ctx.quirks, ctx.secret)
    return { url: auth.url, headers: { ...headers, ...auth.headers }, body }
  }

  handleStreamData(data: string, acc: StreamAccumulator): Rec[] {
    if (data.trim() === '[DONE]') return single(acc.apply({ done: true }))
    const json = JSON.parse(data) as Json
    if (!isRecord(json)) return []
    const fragments: Rec[] = []
    const usage = isRecord(json['usage']) ? json['usage'] : undefined
    const choices = Array.isArray(json['choices']) ? json['choices'] : []
    if (choices.length === 0 && usage !== undefined) {
      pushFragment(fragments, acc.apply({ usage: normalizeUsage(usage['prompt_tokens'], usage['completion_tokens']) ?? undefined }))
      return fragments
    }
    const choice = asRecord(choices[0])
    if (choice === null) return fragments
    const delta = asRecord(choice['delta']) ?? {}
    const shard: Parameters<StreamAccumulator['apply']>[0] = {}
    const text = stringField(delta, 'content')
    if (text !== undefined) shard.text = text
    if (this.reasoningField !== null) {
      const reasoning = stringField(delta, this.reasoningField)
      if (reasoning !== undefined) shard.reasoning = reasoning
    }
    if (Array.isArray(delta['tool_calls'])) {
      for (const rawCall of delta['tool_calls']) {
        const call = asRecord(rawCall)
        if (call === null) continue
        const fn = asRecord(call['function']) ?? {}
        pushFragment(
          fragments,
          acc.apply({
            tool_call: {
              index: typeof call['index'] === 'number' ? call['index'] : 0,
              id: stringField(call, 'id'),
              name: stringField(fn, 'name'),
              arguments_delta: stringField(fn, 'arguments'),
            },
          }),
        )
      }
    }
    if (shard.text !== undefined || shard.reasoning !== undefined) pushFragment(fragments, acc.apply(shard))
    if (usage !== undefined) {
      const normalized = normalizeUsage(usage['prompt_tokens'], usage['completion_tokens'])
      if (normalized !== null) pushFragment(fragments, acc.apply({ usage: normalized }))
    }
    const finish = choice['finish_reason']
    if (typeof finish === 'string') pushFragment(fragments, acc.apply({ stop_reason: finish }))
    return fragments
  }

  parseFull(json: Json): ModelOutput {
    const root = asRecord(json) ?? {}
    const choices = Array.isArray(root['choices']) ? root['choices'] : []
    const choice = asRecord(choices[0]) ?? {}
    const message = asRecord(choice['message']) ?? {}
    const output: ModelOutput = {
      text: stringField(message, 'content') ?? '',
      tool_calls: parseToolCalls(message['tool_calls']),
      usage: null,
    }
    if (this.reasoningField !== null) {
      const reasoning = stringField(message, this.reasoningField)
      if (reasoning !== undefined) output.reasoning = reasoning
    }
    const usage = asRecord(root['usage'])
    if (usage !== null) output.usage = normalizeUsage(usage['prompt_tokens'], usage['completion_tokens'])
    if (typeof choice['finish_reason'] === 'string') output.stop_reason = choice['finish_reason'] as string
    return output
  }
}

  /** openai-responses：`/responses` + 类型化事件流。 */
class OpenAiResponsesAdapter implements Adapter {
  readonly protocol = 'openai-responses'
  private readonly toolIndex = new Map<string, number>()
  private nextToolIndex = 0

  build(ctx: RequestContext): BuiltRequest {
    const body: Rec = { model: ctx.model, input: mapMessages(ctx), stream: ctx.stream }
    applyOptional(body, ctx)
    const auth = applyAuth(joinUrl(ctx.base_url, '/responses'), ctx.quirks, ctx.secret)
    const headers = baseHeaders(ctx.quirks, ctx.stream ? 'text/event-stream' : 'application/json')
    return { url: auth.url, headers: { ...headers, ...auth.headers }, body }
  }

  handleStreamData(data: string, acc: StreamAccumulator): Rec[] {
    const json = JSON.parse(data) as Json
    if (!isRecord(json)) return []
    const type = stringField(json, 'type') ?? ''
    if (type === 'response.output_text.delta') return single(acc.apply({ text: stringField(json, 'delta') ?? '' }))
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      return single(acc.apply({ reasoning: stringField(json, 'delta') ?? '' }))
    }
    if (type === 'response.output_item.added') return this.outputItemAdded(json, acc)
    if (type === 'response.function_call_arguments.delta') return this.argumentsDelta(json, acc)
    if (type === 'response.completed') return this.completed(json, acc)
    if (type === 'response.failed' || type === 'error') {
      throw new ModelError('model_server_error', `responses stream ${type}`, { retryable: true })
    }
    return []
  }

  private outputItemAdded(json: Rec, acc: StreamAccumulator): Rec[] {
    const item = asRecord(json['item'])
    if (item === null || item['type'] !== 'function_call') return []
    const itemId = stringField(item, 'id') ?? stringField(item, 'call_id') ?? ''
    const index = this.nextToolIndex
    this.nextToolIndex += 1
    this.toolIndex.set(itemId, index)
    return single(acc.apply({ tool_call: { index, id: stringField(item, 'call_id'), name: stringField(item, 'name') } }))
  }

  private argumentsDelta(json: Rec, acc: StreamAccumulator): Rec[] {
    const itemId = stringField(json, 'item_id') ?? ''
    const index = this.toolIndex.get(itemId) ?? 0
    return single(acc.apply({ tool_call: { index, arguments_delta: stringField(json, 'delta') ?? '' } }))
  }

  private completed(json: Rec, acc: StreamAccumulator): Rec[] {
    const response = asRecord(json['response']) ?? {}
    const usage = asRecord(response['usage'])
    const normalized = usage === null ? null : normalizeUsage(usage['input_tokens'], usage['output_tokens'])
    return single(acc.apply({ usage: normalized ?? undefined, done: true }))
  }

  parseFull(json: Json): ModelOutput {
    const root = asRecord(json) ?? {}
    const output = Array.isArray(root['output']) ? root['output'] : []
    let text = ''
    const toolCalls: Json[] = []
    for (const item of output) {
      const record = asRecord(item)
      if (record === null) continue
      if (record['type'] === 'message') text += extractResponseText(record['content'])
      if (record['type'] === 'function_call') {
        toolCalls.push({
          id: record['call_id'] ?? null,
          name: record['name'] ?? null,
          arguments: parseArgs(stringField(record, 'arguments')),
        })
      }
    }
    const usage = asRecord(root['usage'])
    const result: ModelOutput = {
      text,
      tool_calls: toolCalls,
      usage: usage === null ? null : normalizeUsage(usage['input_tokens'], usage['output_tokens']),
    }
    if (typeof root['status'] === 'string') result.stop_reason = root['status'] as string
    return result
  }
}

function extractResponseText(content: Json | undefined): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const record = asRecord(part)
    if (record !== null && typeof record['text'] === 'string') text += record['text'] as string
  }
  return text
}

  /** anthropic-messages：`/messages` + 顶层 system 字段 + `x-api-key`。 */
class AnthropicMessagesAdapter implements Adapter {
  readonly protocol = 'anthropic-messages'
  private usageInput = 0
  private usageOutput = 0

  build(ctx: RequestContext): BuiltRequest {
    const system = collectSystem(ctx.messages)
    const body: Rec = {
      model: ctx.model,
      messages: mapMessages(ctx).filter((item) => !isRecord(item) || item['role'] !== ctx.quirks.system_role),
      max_tokens: typeof ctx.params['max_tokens'] === 'number' ? ctx.params['max_tokens'] : 4096,
      stream: ctx.stream,
    }
    if (system.length > 0) body['system'] = system
    applyOptional(body, ctx)
    const auth = applyAuth(joinUrl(ctx.base_url, '/messages'), ctx.quirks, ctx.secret)
    const headers = baseHeaders(ctx.quirks, ctx.stream ? 'text/event-stream' : 'application/json')
    return { url: auth.url, headers: { ...headers, ...auth.headers }, body }
  }

  handleStreamData(data: string, acc: StreamAccumulator): Rec[] {
    const json = JSON.parse(data) as Json
    if (!isRecord(json)) return []
    const type = stringField(json, 'type') ?? ''
    if (type === 'message_start') return this.messageStart(json, acc)
    if (type === 'content_block_start') return this.blockStart(json, acc)
    if (type === 'content_block_delta') return this.blockDelta(json, acc)
    if (type === 'message_delta') return this.messageDelta(json, acc)
    if (type === 'message_stop') return single(acc.apply({ done: true }))
    if (type === 'error') throw new ModelError('model_server_error', 'anthropic stream error', { retryable: true })
    return []
  }

  private messageStart(json: Rec, acc: StreamAccumulator): Rec[] {
    const message = asRecord(json['message']) ?? {}
    const usage = asRecord(message['usage'])
    if (usage !== null && typeof usage['input_tokens'] === 'number') {
      this.usageInput = usage['input_tokens'] as number
      return single(acc.apply({ usage: normalizeUsage(this.usageInput, this.usageOutput) ?? undefined }))
    }
    return []
  }

  private blockStart(json: Rec, acc: StreamAccumulator): Rec[] {
    const block = asRecord(json['content_block'])
    if (block === null || block['type'] !== 'tool_use') return []
    const index = typeof json['index'] === 'number' ? json['index'] : 0
    return single(acc.apply({ tool_call: { index, id: stringField(block, 'id'), name: stringField(block, 'name') } }))
  }

  private blockDelta(json: Rec, acc: StreamAccumulator): Rec[] {
    const delta = asRecord(json['delta']) ?? {}
    const index = typeof json['index'] === 'number' ? json['index'] : 0
    if (delta['type'] === 'text_delta') return single(acc.apply({ text: stringField(delta, 'text') ?? '' }))
    if (delta['type'] === 'thinking_delta') return single(acc.apply({ reasoning: stringField(delta, 'thinking') ?? '' }))
    if (delta['type'] === 'input_json_delta') {
      return single(acc.apply({ tool_call: { index, arguments_delta: stringField(delta, 'partial_json') ?? '' } }))
    }
    return []
  }

  private messageDelta(json: Rec, acc: StreamAccumulator): Rec[] {
    const usage = asRecord(json['usage'])
    const delta = asRecord(json['delta']) ?? {}
    const fragments: Rec[] = []
    if (usage !== null && typeof usage['output_tokens'] === 'number') {
      this.usageOutput = usage['output_tokens'] as number
      pushFragment(fragments, acc.apply({ usage: normalizeUsage(this.usageInput, this.usageOutput) ?? undefined }))
    }
    if (typeof delta['stop_reason'] === 'string') pushFragment(fragments, acc.apply({ stop_reason: delta['stop_reason'] as string }))
    return fragments
  }

  parseFull(json: Json): ModelOutput {
    const root = asRecord(json) ?? {}
    const content = Array.isArray(root['content']) ? root['content'] : []
    let text = ''
    let reasoning = ''
    const toolCalls: Json[] = []
    for (const item of content) {
      const record = asRecord(item)
      if (record === null) continue
      if (record['type'] === 'text') text += stringField(record, 'text') ?? ''
      if (record['type'] === 'thinking') reasoning += stringField(record, 'thinking') ?? ''
      if (record['type'] === 'tool_use') toolCalls.push({ id: record['id'] ?? null, name: record['name'] ?? null, arguments: record['input'] ?? {} })
    }
    const usage = asRecord(root['usage'])
    const result: ModelOutput = {
      text,
      tool_calls: toolCalls,
      usage: usage === null ? null : normalizeUsage(usage['input_tokens'], usage['output_tokens']),
    }
    if (reasoning.length > 0) result.reasoning = reasoning
    if (typeof root['stop_reason'] === 'string') result.stop_reason = root['stop_reason'] as string
    return result
  }
}

function collectSystem(messages: Json[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (!isRecord(message) || message['role'] !== 'system') continue
    if (typeof message['content'] === 'string') parts.push(message['content'])
  }
  return parts.join('\n\n')
}

  /** 按 protocol 取适配器；不支持的协议 → model_unsupported。 */
export function getAdapter(protocol: string, quirks: Quirks): Adapter {
  if (protocol === 'openai-chat') return new OpenAiChatAdapter(quirks)
  if (protocol === 'openai-responses') return new OpenAiResponsesAdapter()
  if (protocol === 'anthropic-messages') return new AnthropicMessagesAdapter()
  throw new ModelError('model_unsupported', `unsupported protocol: ${protocol}`)
}
