// 宿主保留能力类 `host`：保留身份名（不进世界）与方法集。
// 路由与派发共用同一份常量，避免两处口径漂移；`pins` 值为该字面量即解析到宿主自身。

/** 保留能力类名，也是 `pins` 里绑定宿主自身的保留值。 */
export const HOST_CAPABILITY = 'host'

/** 中性 run 生命周期方法名：`run.spawn` = 起一次 detached run；`run.cancel` = 等价 `cancel{run}`。 */
export const HOST_METHOD_SPAWN = 'run.spawn'
export const HOST_METHOD_CANCEL = 'run.cancel'

/**
 * 上一协议版本的宿主保留方法名 → 中性名。仅作一个协议版本的兼容窗口：仍受理，命中即记弃用日志；
 * 窗口结束后随别名一起移除。
 */
export const HOST_METHOD_DEPRECATED_ALIASES: ReadonlyMap<string, string> = new Map([
  ['thread.resume', HOST_METHOD_SPAWN],
  ['thread.terminate', HOST_METHOD_CANCEL],
])

/**
 * 宿主保留能力类的方法集。
 * `validate_package` = 入世校验 dry-run（H13），与 `seed` / `pack` 同一套机械校验、不写世界。
 * `def.read` = 按哈希只读解析 def body（投影只回引用，消费方按需取 body）；有界、越权 fail-closed。
 * `identities.suspend` / `identities.resume` = 运行期休眠 / 恢复（保留索引的运行期隔离）。
 * `run.spawn` / `run.cancel` = 调用方驱动的 run 生命周期（detached run 起停），旧名 `thread.resume`
 * / `thread.terminate` 作为弃用别名并发保留一个协议版本。
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
  HOST_METHOD_SPAWN,
  HOST_METHOD_CANCEL,
  ...HOST_METHOD_DEPRECATED_ALIASES.keys(),
  'validate_package',
])

/**
 * 运行期休眠 / 恢复的结果：`not_found` = 身份不存在 / 无代码世代 / 已退役（不属休眠面）；
 * `isolated` = 身份处于坏分支隔离态（同样不属休眠面，只有新代码世代可经复归判定回来）。
 * 已休眠再 suspend、未休眠再 resume 均为幂等 `{ ok: true }`；resume 后未真正起来（被隔离）
 * 也报 `isolated`，不与「未休眠」的幂等成功混为一谈。
 */
export type IdentitySuspendResult = { ok: true } | { ok: false; code: 'not_found' | 'isolated' }
