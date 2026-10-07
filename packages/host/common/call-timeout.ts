// 效果调用超时的两个判定常量：缺省值与硬上限。
// 住 common/ 而非效果层 / 服务链路层：配置解析（`options.ts`）与入世校验（`assembly/`）都要按它们判定，
// 常量住被判定方会让配置层反向依赖运行层，使「assembly 不 import effect / ledger」在 import 图上不再成立。

/** 效果调用缺省超时；`plugin.json` 无此字段，宿主常量（调用未完成 → 传输层失败）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000

/**
 * 单次调用等待上限的硬上限（毫秒）：`setTimeout` 超过 2^31-1 会溢出成立即触发（1ms），
 * 故任何超时声明 / 选项都必须 ≤ 此值；超限按非法处理，不落到计时器。
 */
export const MAX_CALL_TIMEOUT_MS = 2 ** 31 - 1
