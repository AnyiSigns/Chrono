// 能力类 `budget` 的方法表：model（窗 − 输出 − 余量 → 预算标量与配额）、factor（每模型系数）、
// observe（以真实 usage 更新 EWMA）。
// 预算建模与校准是本插件重逻辑；消费方 `context-window` 只编排与传数。
// 确定、不取时间 / 随机；状态落 `CHRONO_PLUGIN_STATE/calibration.json`（③ 可重算）。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { correctionFactor, observeUsage, parseUsage } from './calibration.ts'
import { computeBudget, parseParams } from './model.ts'
import type { Handler, Json } from 'plugin-sdk'

function requireModel(args: Json): string {
  const model = isRecord(args) ? args['model'] : undefined
  if (typeof model !== 'string' || model.length === 0) {
    throw new BadArgsError('model must be a non-empty string')
  }
  return model
}

function requireEstimate(args: Json): number {
  const estimate = isRecord(args) ? args['estimate'] : undefined
  if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0) {
    throw new BadArgsError('estimate must be a non-negative number')
  }
  return estimate
}

/** 预算建模：窗 − 输出 − 余量 → 预算标量与每来源配额上限；缺档案回落默认并标 `profile_missing`。 */
function model(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const result = computeBudget(parseParams(args))
  return result as unknown as Json
}

/** 当前生效的每模型校正系数；无则 1。 */
function factor(args: Json): Json {
  return { factor: correctionFactor(requireModel(args)) }
}

/** 以真实 usage（可缺）更新该模型系数；返回更新后系数与该次解析出的用量形状。 */
function observe(args: Json): Json {
  const modelName = requireModel(args)
  const estimate = requireEstimate(args)
  const usage = parseUsage(isRecord(args) ? args['usage'] : undefined)
  const next = observeUsage(modelName, estimate, usage)
  return { factor: next, usage: usage as unknown as Json }
}

/** 构造方法表（纯函数 + ③ 可重算状态；无反向调用）。 */
export function createHandlers(): Record<string, Handler> {
  return {
    model: (args) => ({ value: model(args), events: [] }),
    factor: (args) => ({ value: factor(args), events: [] }),
    observe: (args) => ({ value: observe(args), events: [] }),
  }
}
