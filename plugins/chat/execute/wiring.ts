// 接线数据装载：切片清单 / 系统提示 / 工具 schema / title 段 / 空槽与预算口径。
// 基线值住同包 `schema/wiring.json`（启动时读一次，缺省回落内置常量）；改它 = 数据换代热生效。
// 服务只读自身包内 schema，不读世界投影。段序归 #33 图数据（本包不再持静态管道）。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import { asString, isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 会话缺省标题（与 #11 新建会话一致）。 */
export const DEFAULT_TITLE = '新对话'

const DEFAULT_SYSTEM_PROMPT =
  '你是 Chrono 的对话助手。只谈意图与结果，不输出工具名、插件名或能力类名。回答简洁、准确，按用户语言作答。'

/** title 旁路段声明。 */
export interface TitleWiring {
  segment: string
  when: string
  on_fail: string
  args: string[]
  title_default: string
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

function stringArray(value: Json | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function recordOf(value: Json | undefined): Rec {
  return isRecord(value) ? value : {}
}

function titleOf(schema: Rec): TitleWiring {
  const title = recordOf(schema['title'])
  return {
    segment: asString(title['segment']) ?? 'session-title.generate',
    when: asString(title['when']) ?? 'first_message',
    on_fail: asString(title['on_fail']) ?? 'ignore',
    args: stringArray(title['args'], [
      'conversation',
      'first_message',
      'vendor',
      'model',
      'params',
      'config',
      'session',
      'title_default',
    ]),
    title_default: asString(title['title_default']) ?? DEFAULT_TITLE,
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
