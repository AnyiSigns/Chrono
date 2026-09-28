// 三协议适配器：把归一化的 messages / system / max_tokens 字段 / reasoning 档位·map / 工具 / 缓存断点
// 编成请求体；把回包解析为 text / reasoning（中立块）/ tool_calls / usage / 停止原因。
// 有界适配器——每个 protocol 一种，厂商差异经 quirks 与推理能力表声明式覆盖。

import { ModelError } from './errors.ts'
import { applyAuth, encodeReasoning, joinUrl, setByPath } from './quirks.ts'
import type { Quirks } from './quirks.ts'
import { asRecord, stringField, StreamAccumulator } from './stream.ts'
import {
  readReasoningBlocks,
  reasoningBlock,
  replayableBlocks,
  sendsReasoningParam,
} from './reasoning.ts'
import type { ReasoningBlock, ReasoningCapability } from './reasoning.ts'
import type { Json, Rec } from 'plugin-sdk'

/** 厂商中立的缓存提示：断点按映射后消息下标标记稳定前缀的末尾；key 供带键前缀缓存（prompt_cache_key）。 */
export interface CacheHint {
  breakpoints?: number[]
  system?: boolean
  tools?: boolean
  key?: string
}

export interface AdapterIdentity {
  provider: string
  model: string
}

export interface RequestContext {
  base_url: string
  model: string
  provider: string
  messages: Json[]
  params: Rec
  quirks: Quirks
  capability: ReasoningCapability
  secret: string | null
  stream: boolean
  tools: Json | undefined
  tool_choice: Json | undefined
  cache: CacheHint | undefined
}

export interface BuiltRequest {
  url: string
  headers: Rec
  body: Rec
}

export interface ModelOutput {
  text: string
  reasoning?: string
  reasoning_blocks?: ReasoningBlock[]
  tool_calls: Json[]
  usage: Rec | null
  stop_reason?: string
}

export interface Adapter {
  readonly protocol: string
  build(ctx: RequestContext): BuiltRequest
  /** 解析一条 SSE data 载荷为归一化分片（文本 / 推理 / 推理块 / 工具调用 / 用量 / 停止原因）。 */
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
  // 思考 / 推理档位参数由能力表决定是否发送（retention=none 的厂商一律不发）。
  if (sendsReasoningParam(ctx.capability)) {
    const reasoning = encodeReasoning(ctx.quirks, ctx.params['reasoning'])
    if (reasoning !== null) setByPath(body, reasoning.path, reasoning.value)
  }
  if (ctx.tool_choice !== undefined) body['tool_choice'] = ctx.tool_choice
}

/**
 * 工具声明归一：**协议原生**（带非空 `type`）原样透传；**中性声明**取 `name` / `description` /
 * `argsSchema`（或 `parameters`）按协议编形。中性声明缺 `name` 即丢弃（不可寻址）。
 * 这是宿主零业务在协议层的落点：调用方给中性工具目录，协议差异由适配器机械编成。
 */
function toolItems(tools: Json | undefined): Rec[] {
  return Array.isArray(tools) ? tools.filter(isRecord) : []
}

function isNativeTool(tool: Rec): boolean {
  return typeof tool['type'] === 'string' && tool['type'].length > 0
}

function neutralTool(tool: Rec): { name: string; description: string | null; parameters: Json } | null {
  const name = typeof tool['name'] === 'string' ? tool['name'] : ''
  if (name.length === 0) return null
  const description = typeof tool['description'] === 'string' ? tool['description'] : null
  const raw = tool['argsSchema'] !== undefined ? tool['argsSchema'] : tool['parameters']
  const parameters = isRecord(raw) ? raw : { type: 'object' }
  return { name, description, parameters }
}

/** openai-chat / openai-responses 的 function 工具编形。 */
function openAiTools(tools: Json | undefined, style: 'chat' | 'responses'): Rec[] {
  const out: Rec[] = []
  for (const tool of toolItems(tools)) {
    if (isNativeTool(tool)) {
      out.push(tool)
      continue
    }
    const neutral = neutralTool(tool)
    if (neutral === null) continue
    const fn: Rec = { name: neutral.name }
    if (neutral.description !== null) fn['description'] = neutral.description
    fn['parameters'] = neutral.parameters
    out.push(style === 'chat' ? { type: 'function', function: fn } : { type: 'function', ...fn })
  }
  return out
}

/** anthropic-messages 的工具编形：`{name, description, input_schema}`。 */
function anthropicTools(tools: Json | undefined): Rec[] {
  const out: Rec[] = []
  for (const tool of toolItems(tools)) {
    if (isNativeTool(tool)) {
      out.push(tool)
      continue
    }
    const neutral = neutralTool(tool)
    if (neutral === null) continue
    const entry: Rec = { name: neutral.name, input_schema: neutral.parameters }
    if (neutral.description !== null) entry['description'] = neutral.description
    out.push(entry)
  }
  return out
}

function numberField(source: Rec, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * 缓存 token 归一：OpenAI 系 `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` /
 * 顶层 `cached_tokens`；DeepSeek 系 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；
 * Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`；Google `cachedContentTokenCount`。
 * 只落出现过的字段，避免给消费方造零值。
 */
function cacheTokens(source: Rec): Rec {
  const out: Rec = {}
  const promptDetails = isRecord(source['prompt_tokens_details']) ? (source['prompt_tokens_details'] as Rec) : null
  const inputDetails = isRecord(source['input_tokens_details']) ? (source['input_tokens_details'] as Rec) : null
  const cached =
    numberField(source, 'cached_tokens') ??
    (promptDetails === null ? undefined : numberField(promptDetails, 'cached_tokens')) ??
    (inputDetails === null ? undefined : numberField(inputDetails, 'cached_tokens'))
  if (cached !== undefined) out['cached_tokens'] = cached
  const hit = numberField(source, 'prompt_cache_hit_tokens')
  if (hit !== undefined) out['prompt_cache_hit_tokens'] = hit
  const miss = numberField(source, 'prompt_cache_miss_tokens')
  if (miss !== undefined) out['prompt_cache_miss_tokens'] = miss
  const read = numberField(source, 'cache_read_input_tokens')
  if (read !== undefined) out['cache_read_input_tokens'] = read
  const creation = numberField(source, 'cache_creation_input_tokens')
  if (creation !== undefined) out['cache_creation_input_tokens'] = creation
  const googleCached = numberField(source, 'cachedContentTokenCount')
  if (googleCached !== undefined) out['cached_content_tokens'] = googleCached
  return out
}

function normalizeUsage(prompt: Json | undefined, completion: Json | undefined, source?: Rec): Rec | null {
  if (typeof prompt !== 'number' && typeof completion !== 'number') return null
  const promptTokens = typeof prompt === 'number' ? prompt : 0
  const completionTokens = typeof completion === 'number' ? completion : 0
  const usage: Rec = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
  if (source !== undefined) Object.assign(usage, cacheTokens(source))
  return usage
}

/**
 * 工具调用编形（请求方向）：中性形状 `{id,name,arguments}` 按协议编成厂商字段。
 * openai-chat / openai-responses：`{id, type:'function', function:{name, arguments:<json string>}}`；
 * 已是原生形状（带 `type` + `function`）原样透传。
 */
function encodeOpenAiToolCalls(raw: Json): Json {
  if (!Array.isArray(raw)) return raw
  const out: Json[] = []
  for (const item of raw) {
    const call = asRecord(item)
    if (call === null) continue
    if (call['type'] === 'function' && isRecord(call['function'])) {
      out.push(call)
      continue
    }
    const args = call['arguments']
    out.push({
      id: call['id'] ?? null,
      type: 'function',
      function: {
        name: typeof call['name'] === 'string' ? call['name'] : '',
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    })
  }
  return out
}

/** 消息 content 统一成字符串（工具结果 / assistant 文本都是字符串；数组体序列化兜底）。 */
function stringifyContent(content: Json | undefined): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

/** 回传的推理文本（同一消息多块拼接）；无块回 null。 */
function replayText(blocks: ReasoningBlock[]): string | null {
  if (blocks.length === 0) return null
  const text = blocks.map((block) => block.payload).join('')
  return text.length === 0 ? null : text
}

/** openai 系消息映射：工具结果带 `tool_call_id`，assistant 的 `tool_calls` 编成 function 形状；
 *  能力表允许时把捕获的推理按 `reasoning_content` 回传（DeepSeek 思考模式带 tools 的硬要求）。 */
function mapOpenAiMessages(ctx: RequestContext): Json[] {
  const mapped: Json[] = []
  for (const message of ctx.messages) {
    if (!isRecord(message)) continue
    const role = typeof message['role'] === 'string' ? message['role'] : 'user'
    const entry: Rec = { role: role === 'system' ? ctx.quirks.system_role : role }
    if (message['content'] !== undefined) entry['content'] = message['content']
    if (message['name'] !== undefined) entry['name'] = message['name']
    if (message['tool_call_id'] !== undefined) entry['tool_call_id'] = message['tool_call_id']
    if (message['tool_calls'] !== undefined) entry['tool_calls'] = encodeOpenAiToolCalls(message['tool_calls'])
    if (role === 'assistant' && ctx.capability.replay_form === 'reasoning_content') {
      const blocks = replayableBlocks(readReasoningBlocks(message), ctx.capability, ctx.provider, ctx.model)
      const text = replayText(blocks)
      if (text !== null) entry['reasoning_content'] = text
    }
    if (role === 'assistant' && ctx.capability.replay_form === 'reasoning_item') {
      for (const block of replayableBlocks(readReasoningBlocks(message), ctx.capability, ctx.provider, ctx.model)) {
        if (block.encrypted.length === 0) continue
        mapped.push({ type: 'reasoning', encrypted_content: block.encrypted })
      }
    }
    mapped.push(entry)
  }
  return mapped
}

/**
 * anthropic 消息映射：工具结果编成 user 的 `tool_result` 块；assistant 的 `tool_calls` 编成 `tool_use` 块
 * （anthropic 不用顶层 `tool_calls` / `tool_call_id` 字段）；system 由 `build` 顶层 `system` 承担，此处剔除。
 * 能力表要求回传时，assistant 的 thinking / redacted_thinking 块置于内容首位（带签名）。
 */
function mapAnthropicMessages(ctx: RequestContext): Json[] {
  const mapped: Json[] = []
  for (const message of ctx.messages) {
    if (!isRecord(message)) continue
    const role = typeof message['role'] === 'string' ? message['role'] : 'user'
    if (role === ctx.quirks.system_role) continue
    if (role === 'tool') {
      mapped.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: message['tool_call_id'] ?? '', content: stringifyContent(message['content']) },
        ],
      })
      continue
    }
    if (role === 'assistant') {
      const calls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as Json[]) : []
      const replay = replayableBlocks(readReasoningBlocks(message), ctx.capability, ctx.provider, ctx.model)
      if (replay.length > 0 || calls.length > 0) {
        const blocks: Json[] = []
        for (const block of replay) {
          if (block.encrypted.length > 0) blocks.push({ type: 'redacted_thinking', data: block.encrypted })
          else blocks.push({ type: 'thinking', thinking: block.payload, signature: block.signature })
        }
        const text = stringifyContent(message['content'])
        if (text.length > 0) blocks.push({ type: 'text', text })
        for (const item of calls) {
          const call = asRecord(item)
          if (call === null) continue
          blocks.push({ type: 'tool_use', id: call['id'] ?? '', name: call['name'] ?? '', input: call['arguments'] ?? {} })
        }
        mapped.push({ role: 'assistant', content: blocks })
        continue
      }
    }
    mapped.push({ role, content: message['content'] ?? '' })
  }
  return mapped
}

function mapMessages(ctx: RequestContext): Json[] {
  return ctx.quirks.protocol === 'anthropic-messages' ? mapAnthropicMessages(ctx) : mapOpenAiMessages(ctx)
}

/** 把 Anthropic 的一条消息内容编成块数组；已有块数组原样，字符串包成 text 块。 */
function anthropicBlocks(content: Json): Json[] {
  if (Array.isArray(content)) return content
  const text = stringifyContent(content)
  return text.length > 0 ? [{ type: 'text', text }] : []
}

/** 在映射后消息的指定下标处加显式缓存断点（Anthropic `cache_control`）。 */
function markAnthropicCache(messages: Json[], cache: CacheHint | undefined): Json[] {
  const breakpoints = cache?.breakpoints
  if (cache === undefined || !Array.isArray(breakpoints) || breakpoints.length === 0) return messages
  const marked = new Set(breakpoints.filter((index) => Number.isInteger(index) && index >= 0))
  return messages.map((message, index) => {
    if (!marked.has(index) || !isRecord(message)) return message
    const blocks = anthropicBlocks(message['content'] ?? '')
    if (blocks.length === 0) return message
    const last = blocks[blocks.length - 1]
    if (isRecord(last)) last['cache_control'] = { type: 'ephemeral' }
    return { ...message, content: blocks }
  })
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
  private readonly reasoningFields: string[]
  private readonly identity: AdapterIdentity

  constructor(quirks: Quirks, identity: AdapterIdentity) {
    this.identity = identity
    // 未显式声明响应推理字段时，按主流 OpenAI 兼容实现回退：DeepSeek 系 `reasoning_content`、
    // 网关 / OpenAI 系 `reasoning`、部分实现 `thinking`。显式声明则只用声明值。
    this.reasoningFields =
      quirks.reasoning_response_field !== null
        ? [quirks.reasoning_response_field]
        : ['reasoning_content', 'reasoning', 'thinking']
  }

  private pickReasoning(source: Rec): string | undefined {
    for (const field of this.reasoningFields) {
      const value = stringField(source, field)
      if (value !== undefined) return value
    }
    return undefined
  }

  build(ctx: RequestContext): BuiltRequest {
    const body: Rec = { model: ctx.model, messages: mapMessages(ctx), stream: ctx.stream }
    if (ctx.stream && ctx.quirks.stream_usage === 'final_chunk') body['stream_options'] = { include_usage: true }
    applyOptional(body, ctx)
    const tools = openAiTools(ctx.tools, 'chat')
    if (tools.length > 0) body['tools'] = tools
    if (typeof ctx.cache?.key === 'string' && ctx.cache.key.length > 0) body['prompt_cache_key'] = ctx.cache.key
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
      pushFragment(fragments, acc.apply({ usage: normalizeUsage(usage['prompt_tokens'], usage['completion_tokens'], usage) ?? undefined }))
      return fragments
    }
    const choice = asRecord(choices[0])
    if (choice === null) return fragments
    const delta = asRecord(choice['delta']) ?? {}
    const shard: Parameters<StreamAccumulator['apply']>[0] = {}
    const text = stringField(delta, 'content')
    if (text !== undefined) shard.text = text
    const reasoning = this.pickReasoning(delta)
    if (reasoning !== undefined) shard.reasoning = reasoning
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
      const normalized = normalizeUsage(usage['prompt_tokens'], usage['completion_tokens'], usage)
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
    const reasoning = this.pickReasoning(message)
    if (reasoning !== undefined && reasoning.length > 0) {
      output.reasoning = reasoning
      output.reasoning_blocks = [reasoningBlock(this.identity.provider, this.identity.model, 'text', reasoning)]
    }
    const usage = asRecord(root['usage'])
    if (usage !== null) output.usage = normalizeUsage(usage['prompt_tokens'], usage['completion_tokens'], usage)
    if (typeof choice['finish_reason'] === 'string') output.stop_reason = choice['finish_reason'] as string
    return output
  }
}

/** openai-responses：`/responses` + 类型化事件流。 */
class OpenAiResponsesAdapter implements Adapter {
  readonly protocol = 'openai-responses'
  private readonly toolIndex = new Map<string, number>()
  private nextToolIndex = 0
  private readonly identity: AdapterIdentity

  constructor(identity: AdapterIdentity) {
    this.identity = identity
  }

  build(ctx: RequestContext): BuiltRequest {
    const body: Rec = { model: ctx.model, input: mapMessages(ctx), stream: ctx.stream }
    applyOptional(body, ctx)
    const tools = openAiTools(ctx.tools, 'responses')
    if (tools.length > 0) body['tools'] = tools
    if (typeof ctx.cache?.key === 'string' && ctx.cache.key.length > 0) body['prompt_cache_key'] = ctx.cache.key
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
    const fragments: Rec[] = []
    for (const block of this.reasoningBlocksFromOutput(response['output'])) {
      pushFragment(fragments, acc.apply({ reasoning_block: block as unknown as Rec }))
    }
    const usage = asRecord(response['usage'])
    const normalized = usage === null ? null : normalizeUsage(usage['input_tokens'], usage['output_tokens'], usage)
    pushFragment(fragments, acc.apply({ usage: normalized ?? undefined, done: true }))
    return fragments
  }

  private reasoningBlocksFromOutput(output: Json | undefined): ReasoningBlock[] {
    if (!Array.isArray(output)) return []
    const blocks: ReasoningBlock[] = []
    for (const item of output) {
      const record = asRecord(item)
      if (record === null || record['type'] !== 'reasoning') continue
      const text = extractResponseReasoning(record)
      const encrypted = stringField(record, 'encrypted_content') ?? ''
      if (text.length === 0 && encrypted.length === 0) continue
      blocks.push(reasoningBlock(this.identity.provider, this.identity.model, 'text', text, '', encrypted))
    }
    return blocks
  }

  parseFull(json: Json): ModelOutput {
    const root = asRecord(json) ?? {}
    const output = Array.isArray(root['output']) ? root['output'] : []
    let text = ''
    let reasoning = ''
    const blocks: ReasoningBlock[] = []
    const toolCalls: Json[] = []
    for (const item of output) {
      const record = asRecord(item)
      if (record === null) continue
      if (record['type'] === 'message') text += extractResponseText(record['content'])
      if (record['type'] === 'reasoning') {
        const part = extractResponseReasoning(record)
        if (part.length > 0) reasoning += part
        const encrypted = stringField(record, 'encrypted_content') ?? ''
        if (part.length > 0 || encrypted.length > 0) {
          blocks.push(reasoningBlock(this.identity.provider, this.identity.model, 'text', part, '', encrypted))
        }
      }
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
      usage: usage === null ? null : normalizeUsage(usage['input_tokens'], usage['output_tokens'], usage),
    }
    if (reasoning.length > 0) result.reasoning = reasoning
    if (blocks.length > 0) result.reasoning_blocks = blocks
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

/** Responses 的推理项：摘要（summary）与推理正文（content）都是 text 片段。 */
function extractResponseReasoning(record: Rec): string {
  let text = extractResponseText(record['summary'])
  text += extractResponseText(record['content'])
  if (text.length === 0 && typeof record['text'] === 'string') text = record['text'] as string
  return text
}

/** anthropic-messages：`/messages` + 顶层 system 字段 + `x-api-key`。 */
class AnthropicMessagesAdapter implements Adapter {
  readonly protocol = 'anthropic-messages'
  private usageInput = 0
  private usageOutput = 0
  private usageCacheRead = 0
  private usageCacheCreation = 0
  private readonly pendingBlocks = new Map<number, { form: 'text' | 'blocks'; payload: string; signature: string; encrypted: string }>()
  private readonly identity: AdapterIdentity

  constructor(identity: AdapterIdentity) {
    this.identity = identity
  }

  build(ctx: RequestContext): BuiltRequest {
    const system = collectSystem(ctx.messages)
    const mapped = mapMessages(ctx).filter((item) => !isRecord(item) || item['role'] !== ctx.quirks.system_role)
    const body: Rec = {
      model: ctx.model,
      messages: markAnthropicCache(mapped, ctx.cache),
      max_tokens: typeof ctx.params['max_tokens'] === 'number' ? ctx.params['max_tokens'] : 4096,
      stream: ctx.stream,
    }
    if (system.length > 0) {
      body['system'] =
        ctx.cache?.system === true ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system
    }
    applyOptional(body, ctx)
    const tools = anthropicTools(ctx.tools)
    if (tools.length > 0) {
      if (ctx.cache?.tools === true) {
        const last = tools[tools.length - 1]
        if (isRecord(last)) last['cache_control'] = { type: 'ephemeral' }
      }
      body['tools'] = tools
    }
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
    if (type === 'message_stop') return this.messageStop(acc)
    if (type === 'error') throw new ModelError('model_server_error', 'anthropic stream error', { retryable: true })
    return []
  }

  private messageStart(json: Rec, acc: StreamAccumulator): Rec[] {
    const message = asRecord(json['message']) ?? {}
    const usage = asRecord(message['usage'])
    if (usage !== null && typeof usage['input_tokens'] === 'number') {
      this.usageInput = usage['input_tokens'] as number
      if (typeof usage['cache_read_input_tokens'] === 'number') this.usageCacheRead = usage['cache_read_input_tokens'] as number
      if (typeof usage['cache_creation_input_tokens'] === 'number') {
        this.usageCacheCreation = usage['cache_creation_input_tokens'] as number
      }
      return single(acc.apply({ usage: this.usage() ?? undefined }))
    }
    return []
  }

  private blockStart(json: Rec, acc: StreamAccumulator): Rec[] {
    const block = asRecord(json['content_block'])
    if (block === null) return []
    const index = typeof json['index'] === 'number' ? json['index'] : 0
    if (block['type'] === 'thinking') {
      this.pendingBlocks.set(index, { form: 'blocks', payload: '', signature: '', encrypted: '' })
      return []
    }
    if (block['type'] === 'redacted_thinking') {
      const data = stringField(block, 'data') ?? ''
      this.pendingBlocks.set(index, { form: 'blocks', payload: '', signature: '', encrypted: data })
      return []
    }
    if (block['type'] !== 'tool_use') return []
    return single(acc.apply({ tool_call: { index, id: stringField(block, 'id'), name: stringField(block, 'name') } }))
  }

  private blockDelta(json: Rec, acc: StreamAccumulator): Rec[] {
    const delta = asRecord(json['delta']) ?? {}
    const index = typeof json['index'] === 'number' ? json['index'] : 0
    if (delta['type'] === 'text_delta') return single(acc.apply({ text: stringField(delta, 'text') ?? '' }))
    if (delta['type'] === 'thinking_delta') {
      const text = stringField(delta, 'thinking') ?? ''
      const pending = this.pendingBlocks.get(index)
      if (pending !== undefined) pending.payload += text
      return single(acc.apply({ reasoning: text }))
    }
    if (delta['type'] === 'signature_delta') {
      const pending = this.pendingBlocks.get(index)
      if (pending !== undefined) pending.signature = stringField(delta, 'signature') ?? ''
      return []
    }
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
      pushFragment(fragments, acc.apply({ usage: this.usage() ?? undefined }))
    }
    if (typeof delta['stop_reason'] === 'string') pushFragment(fragments, acc.apply({ stop_reason: delta['stop_reason'] as string }))
    return fragments
  }

  private messageStop(acc: StreamAccumulator): Rec[] {
    const fragments: Rec[] = []
    for (const [, pending] of [...this.pendingBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (pending.payload.length === 0 && pending.signature.length === 0 && pending.encrypted.length === 0) continue
      const block = reasoningBlock(
        this.identity.provider,
        this.identity.model,
        pending.form,
        pending.payload,
        pending.signature,
        pending.encrypted,
      )
      pushFragment(fragments, acc.apply({ reasoning_block: block as unknown as Rec }))
    }
    pushFragment(fragments, acc.apply({ done: true }))
    return fragments
  }

  private usage(): Rec | null {
    const usage = normalizeUsage(this.usageInput, this.usageOutput)
    if (usage === null) return null
    if (this.usageCacheRead > 0) usage['cache_read_input_tokens'] = this.usageCacheRead
    if (this.usageCacheCreation > 0) usage['cache_creation_input_tokens'] = this.usageCacheCreation
    return usage
  }

  parseFull(json: Json): ModelOutput {
    const root = asRecord(json) ?? {}
    const content = Array.isArray(root['content']) ? root['content'] : []
    let text = ''
    let reasoning = ''
    const blocks: ReasoningBlock[] = []
    const toolCalls: Json[] = []
    for (const item of content) {
      const record = asRecord(item)
      if (record === null) continue
      if (record['type'] === 'text') text += stringField(record, 'text') ?? ''
      if (record['type'] === 'thinking') {
        const part = stringField(record, 'thinking') ?? ''
        reasoning += part
        blocks.push(
          reasoningBlock(this.identity.provider, this.identity.model, 'blocks', part, stringField(record, 'signature') ?? ''),
        )
      }
      if (record['type'] === 'redacted_thinking') {
        blocks.push(
          reasoningBlock(this.identity.provider, this.identity.model, 'blocks', '', '', stringField(record, 'data') ?? ''),
        )
      }
      if (record['type'] === 'tool_use') toolCalls.push({ id: record['id'] ?? null, name: record['name'] ?? null, arguments: record['input'] ?? {} })
    }
    const usage = asRecord(root['usage'])
    const result: ModelOutput = {
      text,
      tool_calls: toolCalls,
      usage: usage === null ? null : normalizeUsage(usage['input_tokens'], usage['output_tokens'], usage),
    }
    if (reasoning.length > 0) result.reasoning = reasoning
    if (blocks.length > 0) result.reasoning_blocks = blocks
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
export function getAdapter(protocol: string, quirks: Quirks, identity: AdapterIdentity): Adapter {
  if (protocol === 'openai-chat') return new OpenAiChatAdapter(quirks, identity)
  if (protocol === 'openai-responses') return new OpenAiResponsesAdapter(identity)
  if (protocol === 'anthropic-messages') return new AnthropicMessagesAdapter(identity)
  throw new ModelError('model_unsupported', `unsupported protocol: ${protocol}`)
}
