// 设置页数据加载：按 tab 拉只读命令 / config / 密钥状态；只读页统一加载呼吸条 + >8s 文案。
// 命令经本插件入站面（`api/command`）；失败置行内错误，不空白、不弹窗。

import { isRecord } from './config-model.js'
import { vendorTemplates, vendorTemplatesFromResult } from './onboarding.js'
import { loadNotify } from './notify-actions.js'

/** 包一层加载态：呼吸条 + >8s 追加「仍在读取…」，结束统一收口。 */
async function withLoading(ctx, task) {
  ctx.state.loading = true
  ctx.state.loadingNote = false
  ctx.render()
  ctx.armLoadingNote(() => {
    if (ctx.state.loading) {
      ctx.state.loadingNote = true
      ctx.render()
    }
  })
  try {
    await task()
  } finally {
    ctx.state.loading = false
    ctx.clearLoadingNote()
    ctx.render()
  }
}

/** 按 tab 加载数据；memory 无外部读取。 */
export async function loadTab(ctx, tab) {
  if (tab === 'general') {
    await withLoading(ctx, async () => {
      ctx.state.config = await readConfig(ctx)
      await loadNotify(ctx)
    })
    return
  }
  if (tab === 'model') {
    await withLoading(ctx, async () => {
      ctx.state.config = await readConfig(ctx)
      if (ctx.state.identities === null) ctx.state.identities = await loadIdentities(ctx)
      ctx.state.secrets = await loadSecrets(ctx)
      if (ctx.state.vendors === null) await ctx.loadVendors()
    })
    return
  }
  if (tab === 'plugins' || tab === 'about') {
    await withLoading(ctx, async () => {
      ctx.state.identities = await loadIdentities(ctx)
    })
    return
  }
  if (tab === 'skills') {
    await withLoading(ctx, async () => {
      const result = await ctx.runCommand('settings.skills', null)
      ctx.state.skillProjection = result.ok ? result.value : null
      if (!result.ok) ctx.state.error = { code: result.code, message: '' }
    })
    return
  }
  if (tab === 'orchestration') {
    await withLoading(ctx, () => loadOrchestration(ctx))
    return
  }
  ctx.state.error = null
  ctx.render()
}

/** config 整值（失败 / 非对象 → null，页面按空态处理）。 */
export async function readConfig(ctx) {
  const result = await ctx.runCommand('config.read', null)
  return result.ok && isRecord(result.value) ? result.value : null
}

/** 身份投影（插件页 / 关于页 / 厂商模板兜底）。 */
export async function loadIdentities(ctx) {
  const result = await ctx.runCommand('settings.identities', null)
  return result.ok ? result.value : null
}

/** 厂商模板：优先 `model.vendors`（服务侧装配 + 桥接），不可用时回落身份投影 `vendor-*`。 */
export async function loadVendors(ctx) {
  const result = await ctx.runCommand('model.vendors', null)
  let templates = result.ok ? vendorTemplatesFromResult(result.value) : []
  if (templates.length === 0) {
    if (ctx.state.identities === null) ctx.state.identities = await loadIdentities(ctx)
    templates = vendorTemplates(ctx.state.identities)
  }
  ctx.state.vendors = templates
  return templates
}

/** 密钥引用状态（`secrets.status` → 只回「有没有」）：`{name: has}`。 */
export async function loadSecrets(ctx) {
  const result = await ctx.runCommand('secrets.status', null)
  if (!result.ok || !Array.isArray(result.value)) return {}
  const map = {}
  for (const item of result.value) {
    if (isRecord(item) && typeof item.name === 'string') map[item.name] = item.has === true
  }
  return map
}

/** 编排健康（只读视图）：settings 打开时预载，供 tab 角标在进入编排页前告警。 */
export async function loadHealth(ctx) {
  const result = await ctx.runCommand('orchestration.health', null)
  ctx.state.orch.health = result.ok ? result.value : null
  ctx.state.orch.degraded.health = !result.ok
  if (ctx.state.mode !== 'settings') return
  ctx.updateHealthDot()
  // 编排页打开时就地刷新健康区；其余情况只更新角标，避免整页重渲染丢焦点。
  if (ctx.state.tab === 'orchestration' && ctx.state.loading !== true && ctx.state.rollbackBusy !== true) ctx.render()
}

/** 编排三区数据：图 / Scope 名录 / 健康。 */
export async function loadOrchestration(ctx) {
  const graph = await ctx.runCommand('orchestration.graph', null)
  ctx.state.orch.graph = graph.ok ? graph.value : null
  ctx.state.orch.degraded.graph = !graph.ok
  const scopes = await ctx.runCommand('orchestration.scopes', null)
  ctx.state.orch.scopes = scopes.ok ? scopes.value : null
  ctx.state.orch.degraded.scopes = !scopes.ok
  const health = await ctx.runCommand('orchestration.health', null)
  ctx.state.orch.health = health.ok ? health.value : null
  ctx.state.orch.degraded.health = !health.ok
}
