// 通用 run loop：一次提交的 directives 跑到 done / refused / idle。
// 挂起 → 执行效果（含审计）→ 回灌 results → 以同一 run_id / 同一份 directives / 同一 now 续跑。

import { randomUUID } from 'node:crypto'
import { run } from '../../kernel/index.ts'
import { executeEffect } from './execute.ts'
import type {
  Directive,
  EffRequest,
  EffResult,
  Entry,
  Hash,
  Head,
  Json,
  World,
} from '../../kernel/index.ts'

export interface RoundInput {
  world: World
  head: Head
  directives: Directive[]
  caps: Record<string, boolean>
  limits: { gas: number; depth: number }
  /** 发起者：写进审计 entry 的 `by`。 */
  initiator: string
  now: number
  /** 审计 entry 的落点回调：调用方负责把它立即追加进账本。 */
  onAudit?: (entry: Entry) => void
}

export interface RoundOutcome {
  status: 'done' | 'refused' | 'idle'
  world: World
  head: Head
  journal: Entry[]
  observations: Json[]
}

/** 单次提交内允许的挂起次数上限：防实现缺陷导致死循环，正常远低于此。 */
const MAX_SUSPENSIONS = 100_000

/** 跑一轮：同一 run_id / now，results 只增不改；审计在挂起期间即时落链。 */
export function runRound(input: RoundInput): RoundOutcome {
  const runId = randomUUID()
  const results: Record<Hash, EffResult> = {}
  let world = input.world
  let head = input.head
  for (let step = 0; step < MAX_SUSPENSIONS; step++) {
    const out = run({
      world,
      head,
      run: runId,
      directives: input.directives,
      results,
      limits: input.limits,
      caps: input.caps,
      now: input.now,
    })
    if (out.status !== 'waiting') {
      return {
        status: out.status,
        world: out.world,
        head: out.head,
        journal: out.journal,
        observations: out.observations,
      }
    }
    const eff = out.pending as EffRequest
    const executed = executeEffect(eff, world, head, input.initiator, input.now)
    results[eff.id] = executed.result
    world = executed.world
    head = executed.head
    if (executed.auditEntry !== null && input.onAudit !== undefined) {
      input.onAudit(executed.auditEntry)
    }
  }
  return {
    status: 'refused',
    world,
    head,
    journal: [],
    observations: [{ kind: 'refused', reasons: ['too_many_suspensions'] }],
  }
}
