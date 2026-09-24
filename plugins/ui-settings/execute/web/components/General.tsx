// 通用页：主题三卡片、语言（置灰只读）、通知分组（含浏览器权限状态）、配置导入 / 导出。
// 即时保存 + 150ms 行高亮；主题切换由壳写 config（唯一一次写）。

import { useRef } from 'react'
import { Icon, LabeledButton, Row, Section, TextButton, Toggle, useVc } from './ui.tsx'
import { emptyConfig, setNotify } from '../config-model.ts'
import {
  canRequestPermission,
  mergeToggles,
  NOTIFY_KEYS,
  permissionMessageKey,
  permissionTone,
  toggleValue,
  togglesDisabled,
} from '../notify.ts'

const THEME_CARDS = [
  { id: 'day', icon: 'sun' },
  { id: 'night', icon: 'moon' },
  { id: 'system', icon: 'monitor' },
]

export function GeneralPanel() {
  const vc = useVc()
  const current = vc.currentThemePref()
  return (
    <>
      <Section nameKey="settings_theme">
        <div className="settings-theme-cards" data-saved-key="theme" data-saved={vc.state.savedKey === 'theme' ? 'true' : undefined}>
          {THEME_CARDS.map((card) => {
            const selected = current === card.id
            return (
              <div className="settings-theme-wrap" key={card.id}>
                <button
                  type="button"
                  className="settings-theme-card"
                  aria-pressed={selected ? 'true' : 'false'}
                  onClick={async () => {
                    try {
                      const result = await vc.setTheme(card.id)
                      vc.state.error = result.ok ? null : { code: result.code, message: '' }
                    } catch {
                      vc.state.error = { code: 'ui_unreachable', message: '' }
                    } finally {
                      vc.render()
                    }
                  }}
                >
                  <Icon name={card.icon} size={20} />
                  <span>{vc.text(`settings_theme_${card.id}`)}</span>
                </button>
                {selected ? <Icon name="check" size={16} className="settings-theme-check" /> : null}
              </div>
            )
          })}
        </div>
      </Section>
      <Section nameKey="settings_language">
        <Row label={vc.text('settings_language')}>
          <span className="settings-muted">{vc.text('settings_language_locked')}</span>
        </Row>
      </Section>
      <Section nameKey="settings_notify">
        <PermissionRow />
        {NOTIFY_KEYS.map((key) => (
          <Row key={key} label={vc.text(`settings_notify_${key}`)} savedKey={`notify:${key}`}>
            <Toggle
              checked={toggleValue(vc.state.notify, key)}
              label={vc.text(`settings_notify_${key}`)}
              disabled={togglesDisabled(vc.state.permission)}
              onChange={async (nextValue) => {
                const next = mergeToggles(vc.state.notify, { [key]: nextValue })
                const result = await vc.writeConfig(
                  setNotify(vc.state.config ?? emptyConfig(), key, nextValue),
                  `notify:${key}`,
                )
                if (result.ok) {
                  vc.state.notify = next
                  vc.state.error = null
                } else {
                  vc.state.error = { code: result.code, message: '' }
                }
                vc.render()
              }}
            />
          </Row>
        ))}
      </Section>
      <ConfigActions />
    </>
  )
}

function PermissionRow() {
  const vc = useVc()
  const permission = vc.state.permission
  return (
    <div className="settings-row">
      <span className="settings-row-label">{vc.text('settings_notify_permission')}</span>
      <span className="settings-row-value">
        <span className="settings-dot" data-tone={permissionTone(permission)} />
        <span>{vc.text(permissionMessageKey(permission))}</span>
        {canRequestPermission(permission) ? (
          <TextButton label={vc.text('settings_notify_request')} onClick={() => void vc.requestPermission()} />
        ) : null}
      </span>
    </div>
  )
}

function ConfigActions() {
  const vc = useVc()
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <Section>
      <div className="settings-row" data-saved-key="import" data-saved={vc.state.savedKey === 'import' ? 'true' : undefined}>
        <span className="settings-row-label">{`${vc.text('settings_import')} / ${vc.text('settings_export')}`}</span>
        <span className="settings-row-value">
          <LabeledButton icon="download" label={vc.text('settings_export')} onClick={() => vc.exportConfig()} />
          <LabeledButton icon="upload" label={vc.text('settings_import')} onClick={() => inputRef.current?.click()} />
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files !== null && event.target.files.length > 0 ? event.target.files[0] : null
              event.target.value = ''
              if (file !== null) void vc.importConfig(file)
            }}
          />
        </span>
      </div>
    </Section>
  )
}
