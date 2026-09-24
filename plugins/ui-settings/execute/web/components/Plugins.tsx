// 插件页（只读）：主行 = 插件名 + 状态点；次行 = 世代短哈希与 pins 摘要。人可见只读，不做管理入口。

import { EmptyState, useVc } from './ui.tsx'
import { joinMeta } from '../config-model.ts'
import { identityRows, pluginSubParts } from '../settings-model.ts'

export function PluginsPanel() {
  const vc = useVc()
  const rows = identityRows(vc.state.identities)
  if (rows.length === 0) return <EmptyState nameKey="settings_empty_plugins" hintKey="settings_empty_plugins_hint" />
  return (
    <div className="settings-list">
      {rows.map((rowData) => (
        <PluginRow row={rowData} key={rowData.id} />
      ))}
    </div>
  )
}

function PluginRow(props: { row: any }) {
  const vc = useVc()
  const row = props.row
  const sub = joinMeta(pluginSubParts(row, vc.text))
  return (
    <div className="settings-plugin-item">
      <div className="settings-plugin-main">
        <span className="settings-plugin-id">{row.id}</span>
        <span className="settings-dot" data-tone={row.retired ? 'muted' : 'success'} />
        <span className="settings-list-meta">
          {row.retired ? vc.text('settings_plugins_retired') : vc.text('settings_plugins_active')}
        </span>
      </div>
      {sub.length > 0 ? <div className="settings-plugin-sub">{sub}</div> : null}
    </div>
  )
}
