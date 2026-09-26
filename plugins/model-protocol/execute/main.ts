// `model-protocol` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道：方法只返回值 / 写计划。
// 第二方向：服务发 `port.call`（反向调用 secrets / config），宿主回 `port.result` / `port.error`（按 id 配对）。
// 事件出口（model.delta）直接经 SDK 上行通道，载荷带 run / thread（自帧 env 读取，不自取时间）。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { RateLimiter, rateLimitFile } from './resilience.ts'
import type { Json, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'model'
const LOG = makeLogger('model-protocol')

/** 构造服务实例：两条反向调用链（secrets / config）+ 令牌桶 + 事件出口，均由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const secrets = new PortLink({ write: ctx.emit, idPrefix: 'mp-secrets' })
  const config = new PortLink({ write: ctx.emit, idPrefix: 'mp-config' })
  const links = [secrets, config]
  let seq = 0
  const emit = (topic: string, payload: Json): void => {
    seq += 1
    ctx.emit({ v: '1', id: `model-evt-${seq}`, kind: 'event', topic, payload })
  }
  const limiter = new RateLimiter(rateLimitFile(ctx.env))
  const failAll = (): void => {
    for (const link of links) link.failAll()
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    defaultState: 'recomputable',
    handlers: createHandlers({ secrets, config, limiter, emit }),
    emit: ctx.emit,
    log: LOG,
    // 两条链共存：SDK 的 settle 对任何 port.result / port.error 都返回 true（即使非本链 id），
    // 故必须逐一结算、不可短路，否则后一条链的应答会被前一条吞掉而悬挂。
    intercept: (message) => {
      let consumed = false
      for (const link of links) consumed = link.settle(message) || consumed
      return consumed
    },
    onDrain: failAll,
    onClose: failAll,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
