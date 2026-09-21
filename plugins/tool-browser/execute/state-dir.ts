// 插件 ③ 目录：宿主起服务前 mkdir 本身份目录并以 `CHRONO_PLUGIN_STATE` 注入 spawn env。
// 本插件把浏览器 profile（会话状态，可重算）放这里；目录缺失时回落系统临时目录。

/** 本身份 ③ 目录；宿主未注入时回 null。 */
export function resolveStateDir(): string | null {
  const dir = process.env['CHRONO_PLUGIN_STATE']
  return typeof dir === 'string' && dir.length > 0 ? dir : null
}
