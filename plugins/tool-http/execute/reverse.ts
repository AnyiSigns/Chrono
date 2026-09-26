// 反向调用预算常量：宿主正向超时 > 反向等待 > 执行超时的固定余量关系，
// 逐次等待上限由 `PortLink.call` 的 `timeoutMs` 覆盖（见 net.ts / webfetch.ts）。

/** 反向调用等待上限兜底；调用方可按声明执行超时加余量覆盖（见 net.ts）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30000

/** 反向等待在声明抓取超时之上的固定余量：保证「宿主调用超时 > 反向等待 > 抓取超时」。 */
export const REVERSE_TIMEOUT_MARGIN_MS = 5000

/** 宿主 `tool-http.invoke` 的调用超时（与 schema/tool-http.json 的 method_timeouts 一致）。 */
export const HOST_METHOD_TIMEOUT_MS = 130000

/**
 * 执行预算 / 反向等待上界：宿主预算减固定余量再留 1ms，
 * 保证 host > reverse > exec 严格成立——声明再大也不击穿宿主正向超时。
 */
export const MAX_EXEC_BUDGET_MS = HOST_METHOD_TIMEOUT_MS - REVERSE_TIMEOUT_MARGIN_MS - 1

/** Node 定时器可接受的最大延时；超过会溢出为 1ms（反向等待必须 clamp 在此之下）。 */
export const TIMER_MAX_MS = 2 ** 31 - 1
