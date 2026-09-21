// 配置导入 / 导出：导出整份 config JSON（只含 `auth_ref` 引用名）；导入校验后直写 config。
// 导入失败落行内 danger（不弹窗），成功 150ms 行高亮。

import { el } from './dom.js'
import { emptyConfig, exportJson, validateImport } from './config-model.js'

/** 导出 config 为 JSON 下载。 */
export function exportConfig(ctx) {
  const body = ctx.state.config ?? emptyConfig()
  const view = ctx.doc.defaultView
  const blob = new view.Blob([exportJson(body)], { type: 'application/json' })
  const url = view.URL.createObjectURL(blob)
  const anchor = el(ctx.doc, 'a', { attrs: { href: url, download: 'chrono-config.json' } })
  ctx.doc.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  view.URL.revokeObjectURL(url)
}

/** 选文件 → 读取（失败兜底）→ 校验 → 写 config。 */
export function importConfig(ctx) {
  const input = el(ctx.doc, 'input', { attrs: { type: 'file', accept: 'application/json,.json' } })
  input.addEventListener('change', async () => {
    const file = input.files !== null && input.files.length > 0 ? input.files[0] : null
    if (file === null) return
    let content
    try {
      content = await file.text()
    } catch {
      ctx.state.error = { code: 'settings_import_bad_json', message: '' }
      ctx.render()
      return
    }
    const checked = validateImport(content)
    if (!checked.ok) {
      ctx.state.error = { code: checked.code, message: '' }
      ctx.render()
      return
    }
    const result = await ctx.writeConfig(checked.body, 'import')
    ctx.state.error = result.ok ? null : { code: result.code, message: '' }
    ctx.render()
  })
  input.click()
}
