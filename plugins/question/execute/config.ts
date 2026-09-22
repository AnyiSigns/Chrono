// 运行期参数：问题 / 选项上限、是否允许自定义、过期时长从同包 schema 读（缺省回落常量）。
// schema 是身份自述（数据契约），读它不触投影、不写世界；文件缺失 / 形态非法回落缺省。

import { readFileSync } from 'node:fs'
import { isRecord } from './plan.ts'
import type { Json } from './types.ts'

/** 缺省单次问题数上限。 */
export const DEFAULT_MAX_QUESTIONS = 8
/** 缺省单问题选项数上限。 */
export const DEFAULT_MAX_OPTIONS = 12
/** 缺省是否允许自定义输入。 */
export const DEFAULT_ALLOW_CUSTOM = true
/** 缺省过期时长（毫秒）；null = 不设过期。 */
export const DEFAULT_EXPIRES_MS: number | null = 600000

export interface QuestionConfig {
  maxQuestions: number
  maxOptions: number
  allowCustom: boolean
  /** null = 不设过期（item.expires_at 恒 null）。 */
  expiresMs: number | null
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 读同包 schema 的本插件自用参数；不可读 / 非法回落缺省。 */
export function resolveConfig(): QuestionConfig {
  try {
    const text = readFileSync(new URL('../schema/question.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (isRecord(parsed)) {
      const allowCustom = parsed['allow_custom']
      const expires = parsed['expires_ms']
      return {
        maxQuestions: positiveInt(parsed['max_questions'], DEFAULT_MAX_QUESTIONS),
        maxOptions: positiveInt(parsed['max_options'], DEFAULT_MAX_OPTIONS),
        allowCustom: typeof allowCustom === 'boolean' ? allowCustom : DEFAULT_ALLOW_CUSTOM,
        expiresMs:
          expires === null
            ? null
            : typeof expires === 'number' && Number.isInteger(expires) && expires >= 0
              ? expires
              : DEFAULT_EXPIRES_MS,
      }
    }
  } catch {
    // schema 不可读不是致命：用缺省门禁
  }
  return {
    maxQuestions: DEFAULT_MAX_QUESTIONS,
    maxOptions: DEFAULT_MAX_OPTIONS,
    allowCustom: DEFAULT_ALLOW_CUSTOM,
    expiresMs: DEFAULT_EXPIRES_MS,
  }
}
