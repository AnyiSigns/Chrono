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
  'skill',
  'history',
  'style',
]

/** 默认策略（policy.json 缺键时回落；与随包 policy.json 保持同值）。 */
export function defaultPolicy(): Policy {
  return {
    version: 1,
    budget: { margin_ratio: 0.05, default_context_window: 8192, default_max_output: 1024 },
    quota: { skill: 0.1, style: 0.03 },
    prefix: {
      stable: ['prompt', 'tools'],
      order: ['history', 'skill', 'style'],
    },
    retention: { recent_turns: 4, large_artifact_bytes: 65536, oversized_user_chars: 8192 },
    messages: {
      environment:
        '当前环境：工作目录 {workspace_root}；操作系统 {platform}；命令解释器为 PowerShell（跨平台同一套语法），命令默认在此工作目录下执行；相对路径均以此工作目录为基准。',
      interleave_guidance:
        '请用自然语言说明下一步要做什么；不要引用工具标识符，也不要复述参数。',
      input_truncated: '…（此处本轮输入因超出上下文预算被截断）…',
      error_line: '系统错误：{error}',
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
  const retention = isRecord(parsed['retention']) ? parsed['retention'] : {}
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
      skill: num(quota['skill'], base.quota.skill),
      style: num(quota['style'], base.quota.style),
    },
    prefix: {
      stable: sourceList(prefix['stable'], base.prefix.stable),
      order: sourceList(prefix['order'], base.prefix.order),
    },
    retention: {
      recent_turns: Math.max(1, num(retention['recent_turns'], base.retention.recent_turns)),
      large_artifact_bytes: Math.max(1, num(retention['large_artifact_bytes'], base.retention.large_artifact_bytes)),
      oversized_user_chars: Math.max(0, num(retention['oversized_user_chars'], base.retention.oversized_user_chars)),
    },
    messages: {
      environment: str(messages['environment'], base.messages.environment),
      interleave_guidance: str(messages['interleave_guidance'], base.messages.interleave_guidance),
      input_truncated: str(messages['input_truncated'], base.messages.input_truncated),
      error_line: str(messages['error_line'], base.messages.error_line),
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
