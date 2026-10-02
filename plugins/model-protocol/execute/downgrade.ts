// 推理能力降级：4xx 字段协商命中推理字段后，按「先去掉回传、仍被拒则整套关闭思考」改写下发的能力表。
// 与 quirk-repair.ts 同属模型调用内的字段退让；此处只负责把退让档位落到能力表上。

import type { DialectClient, DialectQuirks } from './dialect-link.ts'
import type { RepairKind } from './quirk-repair.ts'
import type { Json, Rec } from 'plugin-sdk'

/** 请求期协议名（impl=sdk 走 SDK，见 protocolLabel）。 */
export function protocolLabel(quirks: DialectQuirks): string {
  return quirks.impl === 'sdk' ? 'sdk' : quirks.protocol
}

/**
 * 降级档：区分「回传可选」「回传强制」「整套关闭」。
 * - 强制回传（DeepSeek/Anthropic/Responses 带签名或加密内容）：去掉回传必然再 400，只能整套关闭思考；
 * - 可选回传（通用 openai-chat/自建端点）：只去掉回传，**保留思考参数与档位**，避免一次 400 把思考能力静默关掉；
 * - `closeAll`：思考参数本身被拒时整套关闭（retention=none，不发参数也不回传）。
 */
export async function downgradedProfile(
  dialect: DialectClient,
  quirks: DialectQuirks,
  current: Json | undefined,
  closeAll = false,
): Promise<Json | undefined> {
  const base = isRecord(current)
    ? (current as Rec)
    : await dialect.reasoningCapability({ protocol: protocolLabel(quirks), impl: quirks.impl })
  if (closeAll || base['requires_replay_in_tool_loop'] === true)
    return await dialect.reasoningCapability({})
  return { ...base, replay_form: null, signature_field: null }
}

/** 依据已应用退让改写推理能力表：先去回传；仍被拒则整套关闭思考。 */
export async function capabilityWithRepairs(
  dialect: DialectClient,
  quirks: DialectQuirks,
  base: Json | undefined,
  applied: ReadonlySet<RepairKind>,
): Promise<Json | undefined> {
  if (applied.has('drop_reasoning_param'))
    return await downgradedProfile(dialect, quirks, base, true)
  if (applied.has('drop_reasoning_replay'))
    return await downgradedProfile(dialect, quirks, base, false)
  return base
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
