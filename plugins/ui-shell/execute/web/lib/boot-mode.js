// 无配置判据：`config.read` 返回值含 `vendor` 键 ⇒ 引导完成（ready），否则 onboarding。
// 壳自身不读投影，判据只来自命令返回值；服务端与浏览器侧共用同一实现。

export function deriveBootMode(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'onboarding'
  return Object.prototype.hasOwnProperty.call(value, 'vendor') ? 'ready' : 'onboarding'
}
