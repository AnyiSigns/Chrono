// 换代跟随：链头推进后把新世界交给装配运行时串行应用，并逐身份广播世代变化。
// 跟随串行且单调：并发 run 的 done 可能乱序到达，只应用不比当前更旧的链头，且不并发进 applyWorld
// （它会改运行态端点表 / 进程）。用独立链而非落账段，避免长任务堵住提交。

import { isCodeGen, latestCodeGen, latestDataGen } from './assembly/index.ts'
import type { AssemblyRuntimeHandle } from './assembly/index.ts'
import type { BroadcastFn } from './run-registry.ts'
import type { LifecycleRecord } from './lifecycle.ts'
import type { Head, World } from '../kernel/index.ts'

export interface FollowDeps {
  initialWorld: World
  initialHead: Head
  /** 装配运行时 getter：监听先于装配，服务可能在装配完成前触发跟随。 */
  getRuntime: () => AssemblyRuntimeHandle | undefined
  broadcast: BroadcastFn
  safeAppendLifecycle: (record: LifecycleRecord) => void
  isStopping: () => boolean
  /** 跟随成功后的副作用（审计分档世界切换、周期对齐、方法超时重报）；不涉及链头推进。 */
  onApplied: (world: World) => void
}

export interface FollowHandle {
  /** 已应用世界（与运行态端点表同代）：路由 `liveWorld` 用它，避免锚定旧世代。 */
  liveWorld: () => World
  /** 串行应用一个推进后的世界；不推进则原样返回（幂等）。 */
  applyWorldSerial: (world: World, head: Head) => Promise<void>
}

/**
 * 身份「代码世代 active」：active 为代码世代取其自身，为数据世代取最近代码世代；
 * retired（active null）或无代码世代 → null。数据世代变化不算代码变化。
 */
function codeActiveOf(world: World, identityId: string): string | null {
  const identity = world.ids[identityId]
  if (identity === undefined || identity.active === null) return null
  const activeGen = identity.gens.find((gen) => gen.payload === identity.active)
  if (activeGen !== undefined && isCodeGen(world, activeGen)) return identity.active
  return latestCodeGen(world, identityId)?.payload ?? null
}

export function createFollow(deps: FollowDeps): FollowHandle {
  // 启动基准 = writer 初值，与装配初值一致。
  let appliedSeq = deps.initialHead.seq
  let appliedWorld: World = deps.initialWorld

  /**
   * 通知面语义化：按身份 diff 上一份已应用世界与当前世界，只播真正变化者。
   * 代码世代 active 变（含新增 / 退役）→ `code`；否则数据世代 payload 变 → `data`；无变化不发。
   */
  const broadcastIdentityChanges = (prevWorld: World, nextWorld: World): void => {
    const ids = new Set([...Object.keys(prevWorld.ids), ...Object.keys(nextWorld.ids)])
    for (const identity of [...ids].sort()) {
      const prevActive = codeActiveOf(prevWorld, identity)
      const nextActive = codeActiveOf(nextWorld, identity)
      if (prevActive !== nextActive) {
        deps.broadcast('host', 'identity.changed', {
          identity,
          kind: 'code',
          active: nextActive,
          prev: prevActive,
        })
        continue
      }
      const prevData = latestDataGen(prevWorld, identity)?.payload ?? null
      const nextData = latestDataGen(nextWorld, identity)?.payload ?? null
      if (prevData !== nextData) {
        deps.broadcast('host', 'identity.changed', {
          identity,
          kind: 'data',
          active: nextData,
          prev: prevData,
        })
      }
    }
  }

  let runtimeChain: Promise<void> = Promise.resolve()
  const applyWorldSerial = (advancedWorld: World, advancedHead: Head): Promise<void> => {
    const next = runtimeChain.then(async () => {
      const runtime = deps.getRuntime()
      if (runtime === undefined || advancedHead.seq <= appliedSeq) return
      try {
        await runtime.applyWorld(advancedWorld)
      } catch (err) {
        // 跟随失败不推进 appliedSeq / appliedWorld。注意：**不会自动重试同一链头**——
        // 只有后续落账推进到更高链头再次调用 applyWorldSerial 时，才会从 appliedWorld 重新 diff
        // 并重试变更身份（幂等重试）。且 runtime 已完成的副作用（起 / 停服务）不回滚，
        // 失败窗口内运行态可能与世界短暂不一致，由下一次跟随收敛（残留风险，见 runtime.applyWorld）。
        deps.safeAppendLifecycle({
          at: Date.now(),
          kind: 'host',
          event: 'follow_failed',
          reason: err instanceof Error ? err.message : String(err),
        })
        return
      }
      // 成功后才推进：appliedSeq / appliedWorld / 广播 三者一致前进
      appliedSeq = advancedHead.seq
      // 世代已跟随：逐身份广播变化，供缓存型读侧按 code / data 语义失效重取。
      broadcastIdentityChanges(appliedWorld, advancedWorld)
      appliedWorld = advancedWorld
      deps.onApplied(advancedWorld)
    })
    runtimeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return {
    liveWorld: () => appliedWorld,
    applyWorldSerial,
  }
}
