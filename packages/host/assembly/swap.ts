// 代码换代的换人序：新旧服务进程如何交接。
// 缺省（无独占资源声明）：先起新服务 → 端点切新 → drain 旧服务；新旧短暂并存、零空窗，是多数插件的最优序。
// 声明独占资源（如固定端口）：新实例无法与旧实例并存，必须先把旧服务 drain 退场再起新服务；
// 代价是该身份在旧进程退出到新进程握手完成之间不可用（短暂空窗），用可用性换资源正确性。
// 插件只声明「我独占某类资源」这一事实，换人序由宿主据此决定，故以后换调度策略不必改插件。

import { stopChild, waitForExit } from './supervision.ts'
import type { ServiceRuntime } from './supervision.ts'
import type { PluginDecl } from './decl.ts'
import type { Hash } from '../../kernel/index.ts'

/** 换人序所需的运行时能力；由 `AssemblyRuntime` 以闭包注入，避免本模块依赖其私有状态。 */
export interface SwapHost {
  isStopping: () => boolean
  isIsolated: (id: string) => boolean
  serviceOf: (id: string) => ServiceRuntime | undefined
  /** 登记新服务：写入服务表、挂端点、起健康探针。 */
  adoptService: (service: ServiceRuntime) => void
  /** 从服务表移除（仅当当前实例匹配，避免误删更新的实例）。 */
  removeService: (id: string, service: ServiceRuntime) => void
  launch: (id: string, gen: Hash, decl: PluginDecl) => Promise<ServiceRuntime>
  /** 端点重挂到新世代键（进程不动）。 */
  rekeyEndpoints: (service: ServiceRuntime, gen: Hash, decl: PluginDecl) => void
  /** 阻断某服务的重启排程（换代期间旧世代不得借崩溃重启复活）。 */
  clearRestart: (service: ServiceRuntime) => void
  /** 记起服务 / 握手失败，不决定是否隔离。 */
  recordStartFailure: (id: string, gen: Hash, err: unknown) => void
  /** 排空并停掉被换代取代的服务（不重启）；退出路径记 `service.exit`。 */
  stopSuperseded: (service: ServiceRuntime, reason: string) => Promise<void>
  /** 独占序下新世代起不来：把该身份转入「无服务但保留世代」并按 `restart` 策略重试新世代。 */
  scheduleGenerationRetry: (carrier: ServiceRuntime, gen: Hash, decl: PluginDecl) => void
}

/**
 * 代码换代换人：按**新世代声明**选序。
 * 新世代声明独占资源 → 先 drain 旧再起新（独占序）；否则保持零空窗的重叠序。
 * 以新世代为准：声明描述的是新实例的占用事实，旧实例是否声明不影响新实例能否与它并存。
 */
export async function swapService(
  host: SwapHost,
  id: string,
  oldService: ServiceRuntime,
  newGen: Hash,
  newDecl: PluginDecl,
): Promise<void> {
  // 先阻断旧服务的重启排程：换代期间旧 gen 不得借崩溃重启复活
  host.clearRestart(oldService)
  if (newDecl.exclusive.length > 0) {
    await swapExclusive(host, id, oldService, newGen, newDecl)
    return
  }
  await swapOverlap(host, id, oldService, newGen, newDecl)
}

/**
 * 重叠序（无独占资源）：物化 + 起新服务 + 握手 → 新端点半表先挂（新 run 立即路由新 gen）→
 * 旧服务 drain（期间健康探针缺席）→ 超时强杀；旧 gen 端点行在旧进程收尾时摘除。
 * 新服务起不来 → 新世代不激活：旧进程继续服务（端点行换到新世代键，路由仍命中旧进程），
 * 失败只记运维日志；旧进程退出后按新世代重试。
 */
async function swapOverlap(
  host: SwapHost,
  id: string,
  oldService: ServiceRuntime,
  newGen: Hash,
  newDecl: PluginDecl,
): Promise<void> {
  let next: ServiceRuntime
  try {
    next = await host.launch(id, newGen, newDecl)
  } catch (err) {
    // 新世代不激活：构建 / 启动失败只记运维日志，旧进程继续服务（端点行换到新世代键，
    // 路由仍命中旧进程），依赖者不受影响；待旧进程退出时按新世代重试，成功即真正激活。
    host.recordStartFailure(id, newGen, err)
    host.rekeyEndpoints(oldService, newGen, newDecl)
    return
  }
  if (host.isStopping() || host.isIsolated(id)) {
    stopChild(next.proc, next.link)
    await waitForExit(next.proc, 2_000)
    return
  }
  if (host.serviceOf(id) !== oldService) {
    // 防御：旧服务已被别的路径替换；新服务不得顶掉更新的实例
    stopChild(next.proc, next.link)
    await waitForExit(next.proc, 2_000)
    return
  }
  oldService.draining = true // 先停健康探针与退出重启
  host.adoptService(next)
  await host.stopSuperseded(oldService, 'superseded')
}

/**
 * 独占序（声明独占资源）：先把旧服务 drain 退场（drain → 摘该世代端点 → 记 `service.exit` → 停进程），
 * 再起新服务；该身份在旧进程退出到新进程握手完成之间无端点（调用得 `not_loaded`），是声明独占的必然代价。
 * 旧服务已 drain、新服务仍起不来时**不复活旧进程**（那会让运行服务停在旧代码世代，违反「不拿更旧世代顶上」）：
 * 该身份转入「无服务但保留世代」，按 `restart` 策略重试新世代，重试超限才隔离分支。
 */
async function swapExclusive(
  host: SwapHost,
  id: string,
  oldService: ServiceRuntime,
  newGen: Hash,
  newDecl: PluginDecl,
): Promise<void> {
  // 防御：旧服务已被别的路径替换时不得误停更新的实例（与重叠序的替换防御同口径）
  if (host.serviceOf(id) !== oldService) return
  host.removeService(id, oldService)
  await host.stopSuperseded(oldService, 'superseded')
  if (host.isStopping() || host.isIsolated(id)) return
  let next: ServiceRuntime
  try {
    next = await host.launch(id, newGen, newDecl)
  } catch (err) {
    host.recordStartFailure(id, newGen, err)
    host.scheduleGenerationRetry(oldService, newGen, newDecl)
    return
  }
  if (host.isStopping() || host.isIsolated(id)) {
    stopChild(next.proc, next.link)
    await waitForExit(next.proc, 2_000)
    return
  }
  if (host.serviceOf(id) !== undefined) {
    // 防御：等待期间该身份已被别的路径装上服务；新服务不得顶掉更新的实例
    stopChild(next.proc, next.link)
    await waitForExit(next.proc, 2_000)
    return
  }
  host.adoptService(next)
}
