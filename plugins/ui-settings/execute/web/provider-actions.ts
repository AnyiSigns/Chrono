// 厂商表单动作：探测前置校验 → 写 `model.probe` 槽 → `model.discover`；完成时密钥直写 → config 写。
// 当前模型不由本模块设置：对话输入框选择模型时才写 `config.vendor` / `config.model`。

import {
  buildOnboardingConfig,
  configWriteDirective,
  emptyConfig,
  isCodeGenFallbackBody,
  providerList,
  upsertProvider,
} from './config-model.ts'
import {
  buildProbeSlot,
  discoverErrorCode,
  discoverModels,
  formToValue,
  validateBaseUrl,
  validateOnboarding,
  validateProbe,
} from './onboarding.ts'
import { loadSecrets } from './data-load.ts'

/** 完成并进入 / 新建厂商：密钥（可选）→ config 写。返回是否成功。 */
export async function commitProvider(ctx: any, form: any, options: any = {}): Promise<boolean> {
  const value = formToValue(form)
  const invalid = validateOnboarding(value)
  if (invalid !== null) {
    form.error = { code: invalid, message: '' }
    ctx.render()
    return false
  }
  form.busy = true
  form.error = null
  ctx.render()
  try {
    if (form.secret_value.length > 0) {
      const saved = await ctx.postJson('api/secrets/put', { name: form.auth_name, value: form.secret_value })
      if (saved.ok !== true) {
        form.error = { code: 'settings_secret_failed', message: '' }
        return false
      }
    }
    const nextConfig = buildOnboardingConfig(ctx.state.config ?? emptyConfig(), value)
    if (isCodeGenFallbackBody(nextConfig)) {
      form.error = { code: 'not_loaded', message: '' }
      return false
    }
    // 写前重读 active：闭包里的 active 仅当次有效，陈旧读会被内核 `stale_active` 拒写。
    await ctx.refreshConfigActive()
    const wrote = await ctx.applyWrite(configWriteDirective(nextConfig, ctx.configActive))
    if (!wrote.ok) {
      form.error = { code: wrote.code, message: '' }
      return false
    }
    ctx.state.config = nextConfig
    if (typeof options.resetForm === 'function') options.resetForm()
    if (options.closeOnSuccess === true) ctx.closeOverlay()
    ctx.announce(ctx.text('settings_saved'))
    return true
  } finally {
    form.busy = false
    ctx.render()
  }
}

/** 每厂商密钥更新：经入站面 `secrets.put` 直写本地（不进世界 / 导出 / 审计），随后刷新状态点。 */
export async function saveProviderSecret(ctx: any, name: any, value: any, key: any): Promise<boolean> {
  if (typeof name !== 'string' || name.length === 0 || typeof value !== 'string' || value.length === 0) {
    ctx.state.error = { code: 'settings_required', message: '' }
    ctx.render()
    return false
  }
  const result = await ctx.postJson('api/secrets/put', { name, value })
  if (result.ok !== true) {
    ctx.state.error = { code: 'settings_secret_failed', message: '' }
    ctx.render()
    return false
  }
  ctx.state.secrets = await loadSecrets(ctx)
  ctx.state.savedKey = key ?? null
  ctx.state.error = null
  ctx.announce(ctx.text('settings_secret_saved'))
  ctx.render()
  return true
}

/** 编辑已保存厂商：只改 `base_url`，密钥 / 模型 / 档案元数据原样保留。 */
export async function commitProviderEdit(ctx: any, form: any, key: string): Promise<boolean> {
  const badUrl = validateBaseUrl(form.base_url)
  if (badUrl !== null) {
    form.error = { code: badUrl, message: '' }
    ctx.render()
    return false
  }
  form.busy = true
  form.error = null
  ctx.render()
  try {
    const config = ctx.state.config ?? emptyConfig()
    const existing = providerList(config).find((item: any) => item.key === key)?.entry
    const entry = { ...(existing ?? {}), base_url: form.base_url }
    const wrote = await ctx.writeConfig(upsertProvider(config, key, entry), `provider:${key}`)
    if (!wrote.ok) {
      form.error = { code: wrote.code, message: '' }
      return false
    }
    ctx.state.providerForm = null
    ctx.announce(ctx.text('settings_saved'))
    return true
  } finally {
    form.busy = false
    ctx.render()
  }
}

/** 获取模型：校验 → 写探测槽 → 发现；失败落行内 danger，不弹窗。 */
export async function fetchModels(ctx: any, form: any): Promise<void> {
  form.error = null
  const probeError = validateProbe(form)
  if (probeError !== null) {
    form.error = { code: probeError, message: '' }
    ctx.render()
    return
  }
  form.loading = true
  form.loadingNote = false
  ctx.render()
  ctx.armLoadingNote(() => {
    if (form.loading) {
      form.loadingNote = true
      ctx.render()
    }
  })
  try {
    // `local` 引用由宿主本地文件解析：探测前先落密钥，否则 discover 取不到值。
    if (form.auth_kind === 'local' && form.secret_value.length > 0) {
      const saved = await ctx.postJson('api/secrets/put', { name: form.auth_name, value: form.secret_value })
      if (saved.ok !== true) {
        form.error = { code: 'settings_secret_failed', message: '' }
        return
      }
    }
    const probe = buildProbeSlot(formToValue(form))
    const wrote = await ctx.writeSlot(probe)
    if (!wrote.ok) {
      form.error = { code: wrote.code, message: '' }
      return
    }
    const discovered = await ctx.runCommand('model.discover', null)
    if (!discovered.ok) {
      form.error = {
        code: discovered.code === 'not_loaded' ? 'not_loaded' : (discoverErrorCode(discovered.value) ?? discovered.code),
        message: '',
      }
      return
    }
    const models = discoverModels(discovered.value)
    if (models.length === 0) {
      form.error = { code: 'discover_unsupported', message: '' }
      return
    }
    // 与用户手填的自定义 id 合并（保留手填项），全部默认勾选。
    const merged = [...new Set([...form.models, ...models])].sort()
    form.models = merged
    form.selected = merged.slice()
  } finally {
    form.loading = false
    ctx.clearLoadingNote()
    ctx.render()
  }
}
