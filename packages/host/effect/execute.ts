// 效果执行：每次 EffRequest → EffResult 必留一条 EffectAudit def，并被业务写的 ref 指到。
// 审计 def 由宿主直接提交（不经 run directive），以保证它在业务写之前就可寻址。
// 端点解析 / 服务连接属后续阶段；本阶段无端点表，路由结果恒为 not_loaded。

import { H, commit } from '../../kernel/index.ts'
import type {
  EffRequest,
  EffResult,
  Entry,
  Hash,
  Head,
  Json,
  World,
  WriteRequest,
} from '../../kernel/index.ts'

export interface ExecuteOutcome {
  result: EffResult
  world: World
  head: Head
  /** 审计 def 键（= H(Def)）；审计写入失败时为 null。 */
  auditHash: Hash | null
  /** 审计 entry；幂等命中时为 null（def 已在世界，仍可被 ref 指到）。 */
  auditEntry: Entry | null
}

/**
 * 执行一次效果并落审计。世界与链头按引用就地演化（commit 语义）：
 * 调用方必须传入自己独占的世界副本，并在续跑时使用返回的 world / head。
 */
export function executeEffect(
  eff: EffRequest,
  world: World,
  head: Head,
  by: string,
  now: number,
): ExecuteOutcome {
  const result: EffResult = { ok: false, error: 'not_loaded' }
  const auditDef = {
    body: {
      request: eff as unknown as Json,
      result: result as unknown as Json,
      port: eff.port,
      method: eff.method,
    },
  }
  const auditHash = H(auditDef as unknown as Json)
  const request: WriteRequest = {
    id: `audit-${eff.id}`,
    op: 'put',
    target: { expect_pos: head.hash },
    args: auditDef as unknown as Json,
    by,
  }
  const outcome = commit(head, world, request, now)
  if (!outcome.verdict.ok) {
    return { result, world, head, auditHash: null, auditEntry: null }
  }
  const nextHead: Head = outcome.entry
    ? { seq: outcome.entry.seq, hash: outcome.hash as Hash }
    : head
  return { result, world, head: nextHead, auditHash, auditEntry: outcome.entry }
}
