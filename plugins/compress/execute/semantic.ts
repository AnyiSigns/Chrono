// semantic 模式：经反向调用 `model.chat` 出同结构摘要（模型调用不重放、永不缓存）。
// 失败作数据（结构化错误值），不炸本轮：密钥 / 连接 / 解析失败都回 `{error:{code,message}}`。

import { asString, isRecord } from './plan.ts'
import { parseSummary, summaryToJson } from './summary.ts'
import type { Summary } from './summary.ts'
import { BackendError } from './types.ts'
import type { Json, Rec } from './types.ts'
import type { ModelBackend } from './port-link.ts'

const SYSTEM_PROMPT =
  '你是上下文压缩器。读取会话切片与既有摘要，输出且仅输出一个 JSON 对象，' +
  '字段为 goal（字符串）、decisions、facts、open_questions、files、next_steps（均为字符串数组）。' +
  '只保留有信息量的条目，不编造；无法确定的字段用空数组或空串。不要输出解释或代码围栏之外的内容。'

export type SemanticOutcome = { summary: Summary } | { error: { code: string; message: string } }

/** 解析模型输出：允许 ```json 围栏；非对象 / 非 JSON 回 null。 */
function parseModelText(text: string): Summary | null {
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
  return parseSummary(parsed)
}

/** semantic 摘要：`model_config` 由调用方随 args 传入（连接实例，原样透传）。 */
export async function semanticSummary(
  args: Rec,
  existing: Summary,
  model: ModelBackend,
): Promise<SemanticOutcome> {
  const config = args['model_config']
  if (!isRecord(config)) {
    return { error: { code: 'model_config_required', message: 'semantic mode requires model_config' } }
  }
  const messages: Json[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        existing_l1: summaryToJson(existing),
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
  const text = asString(value['text'])
  if (text === null) return { error: { code: 'semantic_empty', message: 'model returned no text' } }
  const summary = parseModelText(text)
  if (summary === null) {
    return { error: { code: 'semantic_parse_failed', message: 'model output is not a JSON summary' } }
  }
  return { summary }
}
