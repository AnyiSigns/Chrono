// 运行期参数：允许的变更类 / 提案条数上限 / 提案大小上限从同包 schema 读（缺省回落常量）。
// diff 上限读 #33 thresholds，不在本 schema 重定义（D14）。

import { readFileSync } from 'node:fs'
import { asStringArray } from './model.ts'
import { isRecord } from './plan.ts'
import type { Json } from './types.ts'

export const DEFAULT_ALLOWED_CLASSES = ['binding', 'instance_growth', 'structure', 'fold']
export const DEFAULT_MAX_PROPOSALS_PER_RUN = 4
export const DEFAULT_MAX_PROPOSAL_BYTES = 262144

export interface Limits {
  allowedClasses: string[]
  maxProposalsPerRun: number
  maxProposalBytes: number
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 读同包 schema 的非安全参数；文件缺失 / 形态非法回落缺省。 */
export function resolveLimits(): Limits {
  try {
    const text = readFileSync(new URL('../schema/orchestration-admin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (isRecord(parsed)) {
      const classes = asStringArray(parsed['allowed_classes'])
      return {
        allowedClasses: classes.length > 0 ? classes : DEFAULT_ALLOWED_CLASSES,
        maxProposalsPerRun: positiveInt(parsed['max_proposals_per_run'], DEFAULT_MAX_PROPOSALS_PER_RUN),
        maxProposalBytes: positiveInt(parsed['max_proposal_bytes'], DEFAULT_MAX_PROPOSAL_BYTES),
      }
    }
  } catch {
    // schema 不可读不是致命：用缺省门禁
  }
  return {
    allowedClasses: DEFAULT_ALLOWED_CLASSES,
    maxProposalsPerRun: DEFAULT_MAX_PROPOSALS_PER_RUN,
    maxProposalBytes: DEFAULT_MAX_PROPOSAL_BYTES,
  }
}
