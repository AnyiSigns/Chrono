// 无配置判据：`config.read` 返回值里存在至少一个已启用的模型条目 ⇒ 引导完成（ready），否则 onboarding。
// 壳自身不读投影，判据只来自命令返回值；服务端与浏览器侧共用同一实现。

export function deriveBootMode(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'onboarding'
  const providers = value.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return 'onboarding'
  for (const provider of Object.values(providers)) {
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) continue
    const models = provider.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    for (const meta of Object.values(models)) {
      if (meta !== null && typeof meta === 'object' && meta.enabled === false) continue
      return 'ready'
    }
  }
  return 'onboarding'
}
