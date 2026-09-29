// 能力类 `dedup` 的方法表：dedup。
// 从 incoming 里挑出与 reference 及已接受项不重复的项（保序）：
// 有向量后端时用余弦阈值判定近似重复；后端缺失 / 失败回落精确文本去重。
// 本服务不读投影、不写世界、不自取时钟。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { dedupNewItems } from './dedup.ts'
import type { EmbeddingBackend } from './port-link.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

const DEFAULT_EMBEDDING_MODEL = 'granite-97m'
const DEFAULT_DEDUP_THRESHOLD = 0.9

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface DedupDeps {
  embedding?: EmbeddingBackend
}

function requireRecord(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}

/** 字符串数组：缺省回空数组；含非字符串即拒。 */
function stringArray(value: Json | undefined, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadArgsError(`${field} must be an array`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new BadArgsError(`${field} must contain strings`)
    out.push(item)
  }
  return out
}

function embeddingModel(args: Rec): string {
  const value = args['model']
  if (value === undefined || value === null) return DEFAULT_EMBEDDING_MODEL
  if (typeof value !== 'string' || value.length === 0)
    throw new BadArgsError('model must be a non-empty string')
  return value
}

function threshold(args: Rec): number {
  const value = args['threshold']
  if (value === undefined || value === null) return DEFAULT_DEDUP_THRESHOLD
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BadArgsError('threshold must be within [0, 1]')
  }
  return value
}

async function dedup(args: Json, deps: DedupDeps): Promise<Json> {
  const parsed = requireRecord(args)
  const incoming = stringArray(parsed['incoming'], 'incoming')
  const reference = stringArray(parsed['reference'], 'reference')
  const result = await dedupNewItems(incoming, reference, {
    embedding: deps.embedding,
    model: embeddingModel(parsed),
    threshold: threshold(parsed),
  })
  return { accepted: result.accepted, dedup: result.dedup }
}

/** 构造方法表（依赖注入：向量化后端由入口提供，便于测试与确定性）。 */
export function createHandlers(deps: DedupDeps): Record<string, Handler> {
  return {
    dedup: async (args: Json, _env: CallEnv): Promise<HandlerResult> => ({
      value: await dedup(args, deps),
      events: [],
    }),
  }
}
