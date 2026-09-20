// 宿主保留能力类 `host`：保留身份名（不进世界）与方法集。
// 路由与派发共用同一份常量，避免两处口径漂移；`pins` 值为该字面量即解析到宿主自身。

/** 保留能力类名，也是 `pins` 里绑定宿主自身的保留值。 */
export const HOST_CAPABILITY = 'host'

/**
 * 宿主保留能力类的方法集。
 * `validate_package` = 入世校验 dry-run（H13），与 `seed` / `pack` 同一套机械校验、不写世界。
 */
export const HOST_METHODS: ReadonlySet<string> = new Set([
  'audit',
  'asset.put',
  'asset.get',
  'source.read',
  'thread.resume',
  'thread.terminate',
  'validate_package',
])
