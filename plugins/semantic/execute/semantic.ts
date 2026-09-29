// semantic 模式：经反向调用 `model.chat` 出同结构摘要（模型调用不重放、永不缓存）。
// 失败作数据（结构化错误值），不炸本轮：密钥 / 连接 / 解析失败都回 `{error:{code,message}}`。
// 本提供方只负责提示词与围栏解析：既有摘要以 `existing_l1` 记录形态传入，模型输出解析成记录后原样回给消费方。

import { isRecord } from 'plugin-sdk'
import { BackendError } from './port-link.ts'
import type { ModelBackend } from './port-link.ts'
import type { Json, Rec } from 'plugin-sdk'

const SYSTEM_PROMPT =
  '你是上下文压缩器。读取会话切片与既有摘要，输出且仅输出一个 JSON 对象，' +
  '字段为 goal（字符串）、decisions、facts、open_questions、files、next_steps（均为字符串数组）。' +
  '只保留有信息量的条目，不编造；无法确定的字段用空数组或空串。不要输出解释或代码围栏之外的内容。'

export type SemanticOutcome = { summary: Rec } | { error: { code: string; message: string } }

/** 解析模型输出：允许 ```json 围栏；非对象 / 非 JSON 回 null。 */
function parseModelText(text: string): Rec | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced === null ? text : fenced[1]).trim()
  if (body.length === 0) return null
  let parsed: Json
  try {
    parsed = JSON.parse(body) as Json
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  return parsed
}

/** 取回包文本；缺失 / 非字符串回 null。 */
function textOf(value: Rec): string | null {
  const text = value['text']
  return typeof text === 'string' ? text : null
}

/**
 * semantic 摘要：`args.model_config` 为连接实例（原样透传给 `model.chat`），
 * `existing_l1` 为既有摘要记录（构建提示词用），`args.session_slice` 为本回合切片。
 */
export async function semanticSummary(
  args: Rec,
  existing: Json,
  model: ModelBackend,
): Promise<SemanticOutcome> {
  const config = args['model_config']
  if (!isRecord(config)) {
    return {
      error: { code: 'model_config_required', message: 'semantic mode requires model_config' },
    }
  }
  const messages: Json[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        existing_l1: existing ?? {},
        session_slice: args['session_slice'] ?? [],
      }),
    },
  ]
  let value: Rec
  try {
    value = await model.chat(config, messages)
  } catch (err) {
    if (err instanceof BackendError) return { error: { code: err.code, message: err.message } }
    return { error: { code: 'model_call_failed', message: (err as Error).message } }
  }
  const text = textOf(value)
  if (text === null) return { error: { code: 'semantic_empty', message: 'model returned no text' } }
  const summary = parseModelText(text)
  if (summary === null) {
    return {
      error: { code: 'semantic_parse_failed', message: 'model output is not a JSON summary' },
    }
  }
  return { summary }
}
