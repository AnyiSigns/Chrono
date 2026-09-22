// 子应用 HTTP 端口推导（默认 `8794`，可用 `CHRONO_UI_PORT_TOY_REACT` 覆盖）。
// 该插件不占壳的挂载槽位，验证时直连本端口；端口可覆盖以便与其它实例错开。

/** 本插件默认监听端口（避开壳挂载表占用的 8787–8793）。 */
export const DEFAULT_PORT = 8794

/** 端口覆盖环境变量名（ID 大写、非字母数字转 `_`）。 */
export const PORT_ENV_KEY = 'CHRONO_UI_PORT_TOY_REACT'

/** 解析端口覆盖值；非法（非整数 / 越界）返回 null（忽略该覆盖）。 */
export function parsePort(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** 按优先级取端口：规范化名 → 原始名 → 默认值。 */
export function resolvePort(env) {
  return (
    parsePort(env[PORT_ENV_KEY]) ??
    parsePort(env['CHRONO_UI_PORT_toy-react']) ??
    DEFAULT_PORT
  )
}
