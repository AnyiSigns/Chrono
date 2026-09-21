// 组装策略的读取与校验（`schema/policy.json`）。
// 服务启动时读取一次；`reload` 帧（数据换代）时重读——热改 = 数据换代 reload，不改代码。
// 缺键回落默认值；形态非法抛错（启动期 ⇒ 服务启动失败；reload 期 ⇒ 记日志保留旧策略）。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Json, Policy, Source } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const POLICY_FILE = resolve(HERE, '..', 'schema', 'policy.json')

const VALID_SOURCES: Source[] = [
  'prompt',
  'tools',
  'input',
  'l2',
  'l1',
  'skill',
  'recall',
  'history',
  'style',
]

/** 默认策略（policy.json 缺键时回落；与随包 policy.json 保持同值）。 */
export function defaultPolicy(): Policy {
  return {
    version: 1,
    budget: { margin_ratio: 0.05, default_context_window: 8192, default_max_output: 1024 },
    quota: { l2: 0.08, l1: 0.08, skill: 0.1, recall: 0.12, style: 0.03 },
    prefix: {
      stable: ['prompt', 'tools'],
      order: ['l2', 'l1', 'skill', 'recall', 'history', 'style'],
    },
    thresholds: { compress_hint_ratio: 0.75 },
    messages: {
      compress_hint: '上下文接近预算上限；请先用自然语言总结并压缩较早的上下文，再继续。',
      interleave_guidance:
        '请用自然语言说明下一步要做什么；不要引用工具标识符，也不要复述参数。',
    },
    modality_fallback: { text_template: '[{kind} 附件：{name}（{mime}）]' },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function sourceList(value: unknown, fallback: Source[]): Source[] {
  if (!Array.isArray(value)) return fallback
  const list = value.filter(
    (item): item is Source => typeof item === 'string' && (VALID_SOURCES as string[]).includes(item),
  )
  return list.length > 0 ? list : fallback
}

/**
 * 校验并归一化 policy（缺键回落默认）。形态非法（非对象 / 顶层不是对象）抛错。
 */
export function parsePolicy(parsed: unknown): Policy {
  if (!isRecord(parsed)) throw new Error('policy.json must be a JSON object')
  const base = defaultPolicy()
  const budget = isRecord(parsed['budget']) ? parsed['budget'] : {}
  const quota = isRecord(parsed['quota']) ? parsed['quota'] : {}
  const prefix = isRecord(parsed['prefix']) ? parsed['prefix'] : {}
  const thresholds = isRecord(parsed['thresholds']) ? parsed['thresholds'] : {}
  const messages = isRecord(parsed['messages']) ? parsed['messages'] : {}
  const modality = isRecord(parsed['modality_fallback']) ? parsed['modality_fallback'] : {}
  const margin = num(budget['margin_ratio'], base.budget.margin_ratio)
  return {
    version: num(parsed['version'], base.version),
    budget: {
      margin_ratio: margin < 0 ? 0 : margin,
      default_context_window: num(budget['default_context_window'], base.budget.default_context_window),
      default_max_output: num(budget['default_max_output'], base.budget.default_max_output),
    },
    quota: {
      l2: num(quota['l2'], base.quota.l2),
      l1: num(quota['l1'], base.quota.l1),
      skill: num(quota['skill'], base.quota.skill),
      recall: num(quota['recall'], base.quota.recall),
      style: num(quota['style'], base.quota.style),
    },
    prefix: {
      stable: sourceList(prefix['stable'], base.prefix.stable),
      order: sourceList(prefix['order'], base.prefix.order),
    },
    thresholds: {
      compress_hint_ratio: num(thresholds['compress_hint_ratio'], base.thresholds.compress_hint_ratio),
    },
    messages: {
      compress_hint: str(messages['compress_hint'], base.messages.compress_hint),
      interleave_guidance: str(messages['interleave_guidance'], base.messages.interleave_guidance),
    },
    modality_fallback: {
      text_template: str(modality['text_template'], base.modality_fallback.text_template),
    },
  }
}

/** 从磁盘读取并校验 policy；读取 / 解析失败抛错。 */
export function loadPolicy(file: string = POLICY_FILE): Policy {
  const text = readFileSync(file, 'utf8')
  return parsePolicy(JSON.parse(text) as Json)
}
