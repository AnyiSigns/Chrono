// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// `memory-consolidate` 退化为时序编排门面：按 layer 反向调用三个提供方
// （l1-maintenance / l2-maintenance / l3-maintenance），自身不再直接读写 owner 服务。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from 'plugin-sdk'
import { BackendError } from './types.ts'
import type { PortCaller } from 'plugin-sdk'
import type { Rec } from './types.ts'

/** `l1-maintenance` 各方法的反向调用等待上限（须大于 l1-maintenance 声明）。 */
export const L1_TIMEOUT_MS = 210000
/** `l2-maintenance.merge` 的反向调用等待上限（须大于 l2-maintenance 声明）。 */
export const L2_MERGE_TIMEOUT_MS = 4100000
/** `l2-maintenance` 其余方法（trim / view / edit）的反向调用等待上限。 */
export const L2_TIMEOUT_MS = 45000
/** `l3-maintenance.solidify` 的反向调用等待上限（须大于 l3-maintenance 声明）。 */
export const L3_SOLIDIFY_TIMEOUT_MS = 680000
/** `l3-maintenance.forget` 的反向调用等待上限（须大于 l3-maintenance 声明）。 */
export const L3_FORGET_TIMEOUT_MS = 625000
/** `l3-maintenance` 其余方法（view / edit）的反向调用等待上限。 */
export const L3_TIMEOUT_MS = 45000

async function invoke(
  link: PortCaller,
  port: string,
  method: string,
  args: Rec,
  timeoutMs: number,
): Promise<Rec> {
  const outcome = await link.call(port, method, args, { timeoutMs })
  if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
  if (!isRecord(outcome.value)) {
    throw new BackendError('maintenance_bad_result', `${port}.${method} returned a non-object`)
  }
  return outcome.value
}

/** L1 提供方后端抽象：生产环境是反向调用 `l1-maintenance.*`，单测注入假后端。 */
export interface L1Backend {
  sweep(args: Rec): Promise<Rec>
  candidates(args: Rec): Promise<Rec>
  view(args: Rec): Promise<Rec>
}

export class RemoteL1 implements L1Backend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  sweep(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l1-maintenance', 'sweep', args, L1_TIMEOUT_MS)
  }

  candidates(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l1-maintenance', 'candidates', args, L1_TIMEOUT_MS)
  }

  view(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l1-maintenance', 'view', args, L1_TIMEOUT_MS)
  }
}

/** L2 提供方后端抽象：生产环境是反向调用 `l2-maintenance.*`，单测注入假后端。 */
export interface L2Backend {
  merge(args: Rec): Promise<Rec>
  trim(args: Rec): Promise<Rec>
  view(args: Rec): Promise<Rec>
  edit(args: Rec): Promise<Rec>
}

export class RemoteL2 implements L2Backend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  merge(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l2-maintenance', 'merge', args, L2_MERGE_TIMEOUT_MS)
  }

  trim(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l2-maintenance', 'trim', args, L2_TIMEOUT_MS)
  }

  view(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l2-maintenance', 'view', args, L2_TIMEOUT_MS)
  }

  edit(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l2-maintenance', 'edit', args, L2_TIMEOUT_MS)
  }
}

/** L3 提供方后端抽象：生产环境是反向调用 `l3-maintenance.*`，单测注入假后端。 */
export interface L3Backend {
  solidify(args: Rec): Promise<Rec>
  forget(args: Rec): Promise<Rec>
  view(args: Rec): Promise<Rec>
  edit(args: Rec): Promise<Rec>
}

export class RemoteL3 implements L3Backend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  solidify(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l3-maintenance', 'solidify', args, L3_SOLIDIFY_TIMEOUT_MS)
  }

  forget(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l3-maintenance', 'forget', args, L3_FORGET_TIMEOUT_MS)
  }

  view(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l3-maintenance', 'view', args, L3_TIMEOUT_MS)
  }

  edit(args: Rec): Promise<Rec> {
    return invoke(this.link, 'l3-maintenance', 'edit', args, L3_TIMEOUT_MS)
  }
}
