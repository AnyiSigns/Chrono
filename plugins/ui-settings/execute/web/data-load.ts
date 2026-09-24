// 设置页数据加载：按 tab 拉只读命令 / config / 密钥状态；只读页统一加载呼吸条 + >8s 文案。
// 命令经壳 api.command（按名路由）；失败置行内错误，不空白、不弹窗。

import { identityActive, identityBody, isCodeGenFallbackBody, isRecord } from './config-model.ts'
import { vendorTemplates, vendorTemplatesFromResult } from './onboarding.ts'
import { loadNotify } from './notify-actions.ts'

/** 包一层加载态：呼吸条 + >8s 追加「仍在读取…」，结束统一收口。
 * 用计数归属并发加载：后发请求不提前收掉先发请求的加载态，全部结束才收口；
 * >8s 提示只在首个加载起计时、后续并发不重置（否则后发请求会把已亮起的提示压掉且不再恢复）。 */
async function withLoading(ctx: any, task: () => Promise<void>): Promise<void> {
  const first = (ctx.state.loadingCount ?? 0) === 0
  ctx.state.loadingCount = (ctx.state.loadingCount ?? 0) + 1
  ctx.state.loading = true
  if (first) {
    ctx.state.loadingNote = false
    ctx.armLoadingNote(() => {
      if (ctx.state.loading) {
        ctx.state.loadingNote = true
        ctx.render()
      }
    })
  }
  ctx.render()
  try {
    await task()
  } finally {
    ctx.state.loadingCount = Math.max(0, (ctx.state.loadingCount ?? 1) - 1)
    if (ctx.state.loadingCount === 0) {
      ctx.state.loading = false
      ctx.state.loadingNote = false
      ctx.clearLoadingNote()
    }
    ctx.render()
  }
}

/** 按 tab 加载数据；memory 无外部读取。 */
export async function loadTab(ctx: any, tab: string): Promise<void> {
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
  if (tab === 'memory') {
    await withLoading(ctx, async () => {
      await loadMemoryView(ctx)
    })
    return
  }
  ctx.state.error = null
  ctx.render()
}

/**
 * config 整值（失败 / 非对象 → null，页面按空态处理）。
 * 读到代码世代回落 body（配置身份尚无数据世代）时退避重试；仍不就绪则回 null，
 * 让页面按空态起步——绝不以回落 body 为写基。`ctx.configActive` 记读到的 active 供写用。
 */
export async function readConfig(ctx: any): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await ctx.runCommand('config.read', null)
    if (!result.ok) return null
    ctx.configActive = identityActive(result.value)
    const body = identityBody(result.value)
    if (!isCodeGenFallbackBody(body)) return isRecord(body) ? body : null
    await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt))
  }
  return null
}

/** 身份投影（插件页 / 关于页 / 厂商模板兜底）。 */
export async function loadIdentities(ctx: any): Promise<any> {
  const result = await ctx.runCommand('settings.identities', null)
  return result.ok ? result.value : null
}

/** 厂商模板：优先 `model.vendors`（服务侧装配 + 桥接），不可用时回落身份投影 `vendor-*`。 */
export async function loadVendors(ctx: any): Promise<any[]> {
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
export async function loadSecrets(ctx: any): Promise<any> {
  const result = await ctx.runCommand('secrets.status', null)
  if (!result.ok || !Array.isArray(result.value)) return {}
  const map: any = {}
  for (const item of result.value) {
    if (isRecord(item) && typeof item.name === 'string') map[item.name] = item.has === true
  }
  return map
}

/** 编排健康（只读视图）：settings 打开时预载，供 tab 角标在进入编排页前告警。 */
export async function loadHealth(ctx: any): Promise<void> {
  const result = await ctx.runCommand('orchestration.health', null)
  ctx.state.orch.health = result.ok ? result.value : null
  ctx.state.orch.degraded.health = !result.ok
  if (ctx.state.mode !== 'settings') return
  ctx.updateHealthDot()
  // 编排页打开时就地刷新健康区；其余情况只更新角标，避免整页重渲染丢焦点。
  if (ctx.state.tab === 'orchestration' && ctx.state.loading !== true && ctx.state.rollbackBusy !== true) ctx.render()
}

/** 编排三区数据：图 / Scope 名录 / 健康。 */
export async function loadOrchestration(ctx: any): Promise<void> {
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

/** 记忆浏览（只读）：`memory.view` → L1 / L2 / L3；失败置行内错误（tab 级重试）。 */
export async function loadMemoryView(ctx: any): Promise<boolean> {
  const result = await ctx.runCommand('memory.view', null)
  const failed = !result.ok || (isRecord(result.value) && result.value.ok === false)
  ctx.state.memory.view = failed ? null : result.value
  ctx.state.memory.viewDegraded = failed
  if (failed) ctx.state.error = { code: 'settings_memory_load_failed', message: '' }
  return !failed
}
