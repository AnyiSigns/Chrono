// 能力类 `semantic` 的方法表：summarize。
// 只做提示词构建与模型输出围栏解析：既有摘要以 `existing_l1` 记录传入，模型输出解析成记录后原样回。
// 模型失败 / 空 / 解析失败一律回结构化错误值（作数据，不炸本轮）。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { semanticSummary } from './semantic.ts'
import type { ModelBackend } from './port-link.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface SemanticDeps {
  model: ModelBackend
}

function requireRecord(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}

async function summarize(args: Json, deps: SemanticDeps): Promise<Json> {
  const parsed = requireRecord(args)
  const inner = isRecord(parsed['args']) ? parsed['args'] : {}
  const outcome = await semanticSummary(inner, parsed['existing_l1'] ?? {}, deps.model)
  if ('error' in outcome) return { error: outcome.error }
  return { summary: outcome.summary }
}

/** 构造方法表（依赖注入：模型后端由入口提供，便于测试与确定性）。 */
export function createHandlers(deps: SemanticDeps): Record<string, Handler> {
  return {
    summarize: async (args: Json, _env: CallEnv): Promise<HandlerResult> => ({
      value: await summarize(args, deps),
      events: [],
    }),
  }
}
