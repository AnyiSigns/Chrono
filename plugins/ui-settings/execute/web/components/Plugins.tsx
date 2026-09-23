// 插件页（只读）：身份名 + 状态 + 世代短哈希 + pins 摘要。人可见只读，不做管理入口。

import { EmptyState, useVc } from './ui.tsx'
import { identityRows } from '../settings-model.ts'

export function PluginsPanel() {
  const vc = useVc()
  const rows = identityRows(vc.state.identities)
  if (rows.length === 0) return <EmptyState nameKey="settings_empty_plugins" hintKey="settings_empty_plugins_hint" />
  return (
    <div className="settings-list">
      {rows.map((rowData) => {
        const pins = Object.keys(rowData.pins)
        return (
          <div className="settings-list-item" key={rowData.id}>
            <span className="settings-list-main">{rowData.id}</span>
            <span className="settings-list-meta">
              {rowData.retired ? vc.text('settings_plugins_retired') : vc.text('settings_plugins_active')}
            </span>
            <span className="settings-list-meta">{rowData.activeShort}</span>
            <span className="settings-list-meta">{pins.length > 0 ? pins.join(',') : '-'}</span>
          </div>
        )
      })}
    </div>
  )
}
