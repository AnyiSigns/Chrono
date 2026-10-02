// 接线数据装载：切片清单 / 系统提示 / 工具 schema / title 段 / 空槽与预算口径。
// 基线值住同包 `schema/wiring.json`（启动时读一次，缺省回落内置常量）；改它 = 数据换代热生效。
// 服务只读自身包内 schema，不读世界投影。段序归 #33 图数据（本包不再持静态管道）。

import { readFileSync } from 'node:fs'
import { log } from './log.ts'
import { asString, isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 会话缺省标题（与 #11 新建会话一致）。 */
export const DEFAULT_TITLE = '新对话'

/** 首条消息标题生成提示词（system 消息）的缺省值；缺省回落内置常量。 */
const DEFAULT_TITLE_PROMPT =
  '你是会话标题生成器。请依据用户的第一条消息生成一个简洁的中文标题。' +
  '要求：只输出标题本身，不超过 10 个字，不要加引号、标点、解释或换行。'

/** 标题字数硬顶（Unicode 码点）：无论来源一律钳制到 1..10。 */
const TITLE_HARD_MAX_CHARS = 10
const DEFAULT_TITLE_MAX_TOKENS = 64
const DEFAULT_TITLE_TIMEOUT_MS = 15000

const DEFAULT_SYSTEM_PROMPT =
  '你是 Chrono 的对话助手。只谈意图与结果，不输出工具名、插件名或能力类名。回答简洁、准确，按用户语言作答。'

/** title 旁路段声明：何时生成 + 内联 `model.complete` 的提示词 / 上限 + 兜底标题。 */
export interface TitleWiring {
  when: string
  title_default: string
  prompt: string
  max_chars: number
  max_tokens: number
  timeout_ms: number
}

/** 生效接线（启动时装载一次）。 */
export interface Wiring {
  slices: Rec
  system_prompt: string
  tools: Json[]
  title: TitleWiring
  on_empty_slot: string
  on_budget: string
  stream: Rec
}

function readSchema(): Rec {
  try {
    const text = readFileSync(new URL('../schema/wiring.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read schema/wiring.json: ${(err as Error).message}`)
  }
  return {}
}

function recordOf(value: Json | undefined): Rec {
  return isRecord(value) ? value : {}
}

/** 正整数；否则回落缺省（用于 schema 的可调数值）。 */
function positiveInt(value: Json | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return value
}

/** 标题字数上限：钳制到 1..TITLE_HARD_MAX_CHARS，非法回落硬顶。 */
function titleMaxChars(value: Json | undefined): number {
  const raw = positiveInt(value, TITLE_HARD_MAX_CHARS)
  return Math.min(raw, TITLE_HARD_MAX_CHARS)
}

function titleOf(schema: Rec): TitleWiring {
  const title = recordOf(schema['title'])
  return {
    when: asString(title['when']) ?? 'first_message',
    title_default: asString(title['title_default']) ?? DEFAULT_TITLE,
    prompt: asString(title['prompt']) ?? DEFAULT_TITLE_PROMPT,
    max_chars: titleMaxChars(title['max_chars']),
    max_tokens: positiveInt(title['max_tokens'], DEFAULT_TITLE_MAX_TOKENS),
    timeout_ms: positiveInt(title['timeout_ms'], DEFAULT_TITLE_TIMEOUT_MS),
  }
}

/** 从 schema 默认值构造生效接线。 */
export function loadWiring(): Wiring {
  const schema = readSchema()
  return {
    slices: recordOf(schema['slices']),
    system_prompt: asString(schema['system_prompt']) ?? DEFAULT_SYSTEM_PROMPT,
    tools: Array.isArray(schema['tools']) ? (schema['tools'] as Json[]) : [],
    title: titleOf(schema),
    on_empty_slot: asString(schema['on_empty_slot']) ?? 'noop',
    on_budget: asString(schema['on_budget']) ?? 'fail',
    stream: recordOf(schema['stream']),
  }
}

/** 切片开关（缺省 false）。 */
export function sliceEnabled(wiring: Wiring, name: string): boolean {
  return wiring.slices[name] === true
}
