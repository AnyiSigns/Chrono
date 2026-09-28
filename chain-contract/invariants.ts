// 契约不变量断言器（仅测试期，不进运行路径）。
// I5：结局层码取自封闭集，下游码经 cause 原样透传不改名。
// I6：bag 单真源，生产方与消费方的键都落在同一份 schema 内。

import {
  ATTRIBUTABLE_TO,
  INTERPRET_BAG_KEYS,
  OUTCOME_CODES,
  isAttributableTo,
  isOutcomeCode,
  validateBag,
  validateOutcome,
  validateStepRecord,
  type Rec,
  type TurnOutcome,
} from './src/runtime.ts'

/** I5：断言下游码经 `cause.code` 逐字节原样透传。 */
export function assertCausePassthrough(outcome: TurnOutcome, downstreamCode: string): void {
  if (outcome.cause === null || outcome.cause.code !== downstreamCode) {
    throw new Error(
      `cause passthrough violated: expected cause.code=${JSON.stringify(downstreamCode)}, got ${JSON.stringify(outcome.cause)}`,
    )
  }
}

/** I5：断言结局码与归因维度都取自封闭集。 */
export function assertOutcomeClosed(outcome: TurnOutcome): void {
  if (outcome.code !== null && !isOutcomeCode(outcome.code)) {
    throw new Error(`outcome code outside closed set: ${String(outcome.code)}`)
  }
  if (outcome.attributableTo !== null && !isAttributableTo(outcome.attributableTo)) {
    throw new Error(`outcome attribution outside closed set: ${String(outcome.attributableTo)}`)
  }
  const checked = validateOutcome(outcome)
  if (!checked.ok) throw new Error(`outcome invalid: ${JSON.stringify(checked.outcome)}`)
}

/** I6：断言 bag 通过契约校验（可选严格模式拒绝契约外键）。 */
export function assertValidBag(bag: unknown, strict = false): Rec {
  const checked = validateBag(bag, { strict })
  if (!checked.ok) throw new Error(`bag invalid: ${JSON.stringify(checked.outcome)}`)
  return checked.value
}

/** I6：断言步记录通过契约校验。 */
export function assertValidStepRecord(record: unknown): Rec {
  const checked = validateStepRecord(record)
  if (!checked.ok) throw new Error(`step record invalid: ${JSON.stringify(checked.outcome)}`)
  return checked.value
}

export interface BagKeyDiff {
  /** 生产方写出但 schema 未登记的键（契约真源缺项）。 */
  schemaUnknownProducer: string[]
  /** 消费方读取但 schema 未登记的键（契约真源缺项）。 */
  schemaUnknownConsumer: string[]
  /** 生产方写出但消费方从不读取的键（允许，仅记录）。 */
  producerOnly: string[]
  /** 消费方读取但生产方从不写出的键（契约缺口，需显式登记）。 */
  consumerOnly: string[]
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const set = new Set(right)
  return [...new Set(left)].filter((key) => !set.has(key)).sort()
}

/** I6：计算 bag 键差集，供两侧对拍报告。 */
export function diffBagKeys(params: {
  producerKeys: readonly string[]
  consumerKeys: readonly string[]
  schemaKeys?: readonly string[]
}): BagKeyDiff {
  const schemaKeys = params.schemaKeys ?? INTERPRET_BAG_KEYS
  return {
    schemaUnknownProducer: difference(params.producerKeys, schemaKeys),
    schemaUnknownConsumer: difference(params.consumerKeys, schemaKeys),
    producerOnly: difference(params.producerKeys, params.consumerKeys),
    consumerOnly: difference(params.consumerKeys, params.producerKeys),
  }
}

/** I6：已登记的契约缺口；新增未登记项即断言失败。 */
export interface RegisteredBagGaps {
  /** 生产方写出但 schema 未登记，且已知待补的键。 */
  schemaUnknownProducer?: readonly string[]
  /** 消费方读取但 schema 未登记，且已知待补的键。 */
  schemaUnknownConsumer?: readonly string[]
  /** 消费方先支持、生产方待补的键。 */
  consumerOnly?: readonly string[]
}

function failOnUnregistered(gaps: readonly string[], registered: readonly string[], what: string): void {
  const allowed = new Set(registered)
  const unregistered = gaps.filter((key) => !allowed.has(key))
  if (unregistered.length > 0) {
    throw new Error(`${what}: ${unregistered.join(', ')}`)
  }
}

/**
 * I6：断言生产方与消费方的键都落在同一份 schema 内，且已知缺口已逐项登记。
 * `registered` 记录当前已知的缺口；出现任何未登记项即失败，迫使契约同步更新。
 */
export function assertBagSingleSource(diff: BagKeyDiff, registered: RegisteredBagGaps = {}): void {
  failOnUnregistered(
    diff.schemaUnknownProducer,
    registered.schemaUnknownProducer ?? [],
    'producer keys missing from schema',
  )
  failOnUnregistered(
    diff.schemaUnknownConsumer,
    registered.schemaUnknownConsumer ?? [],
    'consumer keys missing from schema',
  )
  failOnUnregistered(diff.consumerOnly, registered.consumerOnly ?? [], 'consumer-only keys not registered')
}

/** 封闭码集 / 归因集快照，供测试断言集合未被无意改动。 */
export const CLOSED_SETS = {
  attributableTo: [...ATTRIBUTABLE_TO],
  outcomeCodes: [...OUTCOME_CODES],
}
