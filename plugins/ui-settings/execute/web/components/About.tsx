// 关于页：版本、宿主地址、插件数（不渲染账本链头）。

import { Row, Section, useVc } from './ui.tsx'
import { pluginCount } from '../settings-model.ts'
import { PLUGIN_VERSION } from '../version.ts'

export function AboutPanel() {
  const vc = useVc()
  const host = vc.doc.defaultView?.location?.host ?? ''
  return (
    <Section>
      <Row label={vc.text('settings_about_version')}>
        <span className="settings-list-meta">{PLUGIN_VERSION}</span>
      </Row>
      <Row label={vc.text('settings_about_host')}>
        <span className="settings-list-meta">{host}</span>
      </Row>
      <Row label={vc.text('settings_about_plugins')}>
        <span className="settings-list-meta">{String(pluginCount(vc.state.identities))}</span>
      </Row>
    </Section>
  )
}
