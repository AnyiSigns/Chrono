// 共享夹具装载器（仅测试期）：从同目录 JSON 读取唯一一份真实形状夹具，供两侧测试取用。
// JSON 是语言中立件，Rust 侧可直接读同一份文件。

import { readFileSync } from 'node:fs'
import type { Json, ReasoningBlock, TurnOutcome } from '../src/runtime.ts'

function load(name: string): Json {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')) as Json
}

/** chat 生产、loop-policy 消费的 interpret bag（真实键形状）。 */
export const interpretBag = load('interpret-bag.json')

/** 回合事件日志的五种记录各一，外加一个 settle 结局。 */
export const stepRecords = load('step-records.json') as Json[]

/** session 自有存储切片与投影切片。 */
export const sessionSlices = load('session-slices.json')

/** 各节点派发 bag 与归一结果。 */
export const nodeIo = load('node-io.json')

/** 每类回合结局各一（`{label, outcome}`）。 */
export const outcomeFixtures = load('outcomes.json') as { label: string; outcome: TurnOutcome }[]

/** 各厂商推理形态的中立块。 */
export const vendorReasoning = load('vendor-reasoning.json') as Record<string, ReasoningBlock>
