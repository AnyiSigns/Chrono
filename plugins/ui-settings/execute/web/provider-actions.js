// 厂商表单动作：探测前置校验 → 写 `model.probe` 槽 → `model.discover`；完成时密钥直写 → config 写 → 拉档案。
// 探测槽清理由服务返回的计划携带，客户端不再清；`model.profile` 由服务从投影装配，无参调用。

import {
  buildOnboardingConfig,
  configWriteDirective,
  emptyConfig,
  enabledModelIds,
  providerList,
  setSelection,
  slotWriteDirective,
  upsertProvider,
} from './config-model.js'
import {
  buildProbeSlot,
  discoverErrorCode,
  discoverModels,
  defaultModelChoice,
  formToValue,
  validateAuthRef,
  validateBaseUrl,
  validateOnboarding,
  validateProbe,
} from './onboarding.js'
import { loadSecrets, readConfig } from './data-load.js'

/** 完成并进入 / 新建厂商：密钥（可选）→ config 写 → `model.profile`。返回是否成功。 */
export async function commitProvider(ctx, form, options = {}) {
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
    const wrote = await ctx.applyWrite(configWriteDirective(nextConfig))
    if (!wrote.ok) {
      form.error = { code: wrote.code, message: '' }
      return false
    }
    ctx.state.config = nextConfig
    await refreshProfile(ctx)
    if (typeof options.resetForm === 'function') options.resetForm()
    if (options.closeOnSuccess === true) ctx.closeOverlay()
    ctx.announce(ctx.text('settings_saved'))
    return true
  } finally {
    form.busy = false
    ctx.render()
  }
}

/** 拉模型档案（服务从 config + 厂商模板投影装配，无参）；失败不阻塞已填表单。 */
export async function refreshProfile(ctx) {
  return ctx.runCommand('model.profile', null)
}

/**
 * 重拉某已保存厂商的档案：`model.profile` 无参、服务按 `config.vendor` 装配，
 * 故先把该厂商设为当前选择（可回放），再拉档案并读回 config 刷新界面。
 */
export async function refreshProvider(ctx, key) {
  const config = ctx.state.config ?? emptyConfig()
  const provider = providerList(config).find((item) => item.key === key)
  if (provider === undefined) return false
  const models = enabledModelIds(provider.entry)
  const model = typeof config.model === 'string' && models.includes(config.model) ? config.model : (models[0] ?? '')
  const selected = setSelection(config, key, model)
  const wrote = await ctx.writeConfig(selected, `provider:${key}`)
  if (!wrote.ok) return false
  const result = await ctx.runCommand('model.profile', null)
  if (!result.ok) {
    ctx.state.error = { code: result.code, message: '' }
    ctx.render()
    return false
  }
  ctx.state.config = await readConfig(ctx)
  ctx.state.savedKey = `provider:${key}`
  ctx.announce(ctx.text('settings_saved'))
  ctx.render()
  return true
}

/** 每厂商密钥更新：经入站面 `secrets.put` 直写本地（不进世界 / 导出 / 审计），随后刷新状态点。 */
export async function saveProviderSecret(ctx, name, value, key) {
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
  ctx.announce(ctx.text('settings_secret_saved'))
  ctx.render()
  return true
}

/** 编辑已保存厂商：只改 `base_url` / `auth_ref`，模型与档案元数据原样保留。 */
export async function commitProviderEdit(ctx, form, key) {
  const badUrl = validateBaseUrl(form.base_url)
  if (badUrl !== null) {
    form.error = { code: badUrl, message: '' }
    ctx.render()
    return false
  }
  const badAuth = validateAuthRef({ kind: form.auth_kind, name: form.auth_name })
  if (badAuth !== null) {
    form.error = { code: badAuth, message: '' }
    ctx.render()
    return false
  }
  form.busy = true
  form.error = null
  ctx.render()
  try {
    const config = ctx.state.config ?? emptyConfig()
    const existing = providerList(config).find((item) => item.key === key)?.entry
    const entry = {
      ...(existing ?? {}),
      name: existing && typeof existing.name === 'string' ? existing.name : key,
      base_url: form.base_url,
      auth_ref: { kind: form.auth_kind, name: form.auth_name },
    }
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
export async function fetchModels(ctx, form) {
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
    const slots = await ctx.readSlots()
    const probe = buildProbeSlot(formToValue(form))
    const wrote = await ctx.applyWrite(slotWriteDirective(slots, ctx.threadKey, probe))
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
    form.models = models
    form.selected = models.slice()
    form.model = defaultModelChoice(models, form.model)
  } finally {
    form.loading = false
    ctx.clearLoadingNote()
    ctx.render()
  }
}
