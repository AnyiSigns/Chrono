// 宿主保留能力类 `host`：保留身份名（不进世界）与方法集。
// 路由与派发共用同一份常量，避免两处口径漂移；`pins` 值为该字面量即解析到宿主自身。

/** 保留能力类名，也是 `pins` 里绑定宿主自身的保留值。 */
export const HOST_CAPABILITY = 'host'

/**
 * 宿主保留能力类的方法集。
 * `validate_package` = 入世校验 dry-run（H13），与 `seed` / `pack` 同一套机械校验、不写世界。
 * `def.read` = 按哈希只读解析 def body（投影只回引用，消费方按需取 body）；有界、越权 fail-closed。
 * `identities.suspend` / `identities.resume` = 运行期休眠 / 恢复（保留索引的运行期隔离）。
 */
export const HOST_METHODS: ReadonlySet<string> = new Set([
  'audit',
  'asset.put',
  'asset.get',
  'blob.put',
  'def.read',
  'identities',
  'identities.suspend',
  'identities.resume',
  'source.read',
  'thread.resume',
  'thread.terminate',
  'validate_package',
])

/**
 * 运行期休眠 / 恢复的结果：`not_found` = 身份不存在 / 无代码世代 / 已退役（不属休眠面）。
 * 已休眠再 suspend、未休眠再 resume 均为幂等 `{ ok: true }`。
 */
export type IdentitySuspendResult = { ok: true } | { ok: false; code: 'not_found' }
