// 子应用 HTTP 端口推导（子应用默认 `8787 + 序号`，可用 `CHRONO_UI_PORT_<ID>` 覆盖）。
// 默认值与壳的挂载表默认值一致（`ui-chat -> 8788`）；两侧各自读同一环境变量，保证装配一致。

/** 壳挂载表给 `ui-chat` 的默认端口。 */
export const DEFAULT_CHAT_PORT = 8788

/** 本插件端口覆盖环境变量名（ID 大写、非字母数字转 `_`）。 */
export const PORT_ENV_KEY = 'CHRONO_UI_PORT_UI_CHAT'

/** 解析端口覆盖值；非法（非整数 / 越界）返回 null（忽略该覆盖）。 */
export function parsePort(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** 按优先级取端口：规范化名 → 原始名 → 默认值。 */
export function resolvePort(env: { [key: string]: string | undefined }): number {
  return (
    parsePort(env[PORT_ENV_KEY]) ??
    parsePort(env['CHRONO_UI_PORT_ui-chat']) ??
    DEFAULT_CHAT_PORT
  )
}
