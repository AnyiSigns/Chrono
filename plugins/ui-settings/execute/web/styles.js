// 本插件的组件样式：只引用壳提供的 token（`/assets/tokens.v1.css`），零硬编码色值；
// 需要半透明处用 `color-mix(... var(--c-*) ...)` 由 token 派生，不写死 rgba / hex。
// 共享 token 未覆盖的组件规格（控件高 / 列表上限 / 呼吸时长 / 遮罩比 / 描边 / 语义点）以
// `.settings-root` 上的局部自定义属性收口，作**组件规格**登记，便于日后上收为全局 token。

export const STYLE_ID = 'ui-settings-styles'

export const STYLE_TEXT = `
.settings-root {
  --settings-control-h: 28px;
  --settings-picks-max-h: 240px;
  --settings-breathe-dur: 1.6s;
  --settings-overlay-mix: 28%;
  --settings-ring-stroke: 1.5px;
  --settings-dot-size: 6px;
  position: fixed; inset: 0; z-index: var(--z-modal);
}
.settings-backdrop { position: absolute; inset: 0; background: color-mix(in srgb, var(--c-text) var(--settings-overlay-mix), transparent); animation: settings-fade var(--motion-base) both; }
.settings-modal { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: var(--settings-w); max-height: var(--settings-h); display: flex; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); box-shadow: var(--shadow-pop); overflow: hidden; animation: settings-rise var(--motion-base) both; }
.settings-nav { flex: none; width: var(--settings-nav-w); position: sticky; top: 0; padding: var(--space-12) var(--space-8); display: flex; flex-direction: column; gap: var(--space-4); background: var(--c-surface); }
.settings-nav-head { display: flex; align-items: center; justify-content: space-between; padding: 0 var(--space-8) var(--space-8); }
.settings-nav-title { font-size: var(--font-size-md); font-weight: var(--weight-strong); }
.settings-tab { display: flex; align-items: center; gap: var(--space-8); height: var(--list-item-h); padding: 0 var(--space-8); background: none; border: none; border-radius: var(--radius-md); color: var(--c-text-2); font: inherit; font-size: var(--font-size-md); text-align: left; cursor: pointer; transition: background-color var(--motion-fast), color var(--motion-fast); }
.settings-tab:hover { background: var(--c-selection); color: var(--c-text); }
.settings-tab[aria-selected="true"] { background: var(--c-selection); color: var(--c-text); font-weight: var(--weight-strong); }
.settings-tab:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.settings-tab-dot { width: var(--settings-dot-size); height: var(--settings-dot-size); border-radius: 50%; background: var(--c-warning); margin-left: auto; }
.settings-content { flex: 1 1 auto; overflow: auto; padding: var(--space-16) var(--space-24) var(--space-24); }
.settings-content-fade { animation: settings-tab-fade var(--motion-base) both; }
.settings-section { margin-bottom: var(--space-24); }
.settings-group-name { font-size: var(--font-size-xs); color: var(--c-text-3); margin-bottom: var(--space-8); }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-12); min-height: var(--list-item-h); font-size: var(--font-size-md); }
.settings-row + .settings-row { margin-top: var(--space-8); }
.settings-row-label { color: var(--c-text); }
.settings-row-value { color: var(--c-text-2); display: flex; align-items: center; gap: var(--space-8); }
[data-saved="true"] { background: var(--c-selection); border-radius: var(--radius-sm); transition: background-color var(--motion-base); }
.settings-muted { color: var(--c-text-3); }
.settings-danger { color: var(--c-danger); font-size: var(--font-size-xs); }
.settings-warning { color: var(--c-warning); font-size: var(--font-size-xs); }
.settings-input { min-height: var(--settings-control-h); padding: 0 var(--space-8); background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-sm); color: var(--c-text); font: inherit; font-size: var(--font-size-sm); }
.settings-input:focus-visible { outline: none; border-color: var(--c-text-3); box-shadow: var(--focus-ring); }
.settings-input:disabled { opacity: .45; cursor: not-allowed; }
.settings-select { min-height: var(--settings-control-h); padding: 0 var(--space-8); background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-sm); color: var(--c-text); font: inherit; font-size: var(--font-size-sm); }
.settings-btn { display: inline-flex; align-items: center; gap: var(--space-4); min-height: var(--settings-control-h); padding: 0 var(--space-12); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-sm); color: var(--c-text); font: inherit; font-size: var(--font-size-sm); cursor: pointer; transition: background-color var(--motion-fast), border-color var(--motion-fast); }
.settings-btn:hover { background: var(--c-selection); }
.settings-btn:active { background: var(--c-border); }
.settings-btn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.settings-btn:disabled { opacity: .45; cursor: not-allowed; }
.settings-btn[data-tone="danger"] { color: var(--c-danger); }
.settings-btn[data-tone="accent"] { background: var(--c-accent); border-color: var(--c-accent); color: var(--c-accent-text); }
.settings-btn[data-tone="accent"]:hover { filter: brightness(1.06); }
.settings-iconbtn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0; background: none; border: none; border-radius: var(--radius-sm); color: var(--c-text-2); cursor: pointer; transition: background-color var(--motion-fast), color var(--motion-fast); }
.settings-iconbtn:hover { background: var(--c-selection); color: var(--c-text); }
.settings-iconbtn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.settings-iconbtn:disabled { opacity: .45; cursor: not-allowed; }
.settings-theme-cards { display: flex; gap: var(--space-8); }
.settings-theme-card { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: var(--space-8); padding: var(--space-12); background: var(--c-surface); border: var(--settings-ring-stroke) solid var(--c-border); border-radius: var(--radius-md); color: var(--c-text-2); font: inherit; font-size: var(--font-size-xs); cursor: pointer; transition: border-color var(--motion-fast), background-color var(--motion-fast); }
.settings-theme-card:hover { background: var(--c-selection); }
.settings-theme-card[aria-pressed="true"] { border-color: var(--c-accent); color: var(--c-text); }
.settings-theme-card:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.settings-theme-check { position: absolute; }
.settings-theme-wrap { position: relative; }
.settings-theme-wrap .settings-theme-check { top: var(--space-4); right: var(--space-4); color: var(--c-accent); }
.settings-dot { width: var(--settings-dot-size); height: var(--settings-dot-size); border-radius: 50%; flex: none; }
.settings-dot[data-tone="success"] { background: var(--c-success); }
.settings-dot[data-tone="danger"] { background: var(--c-danger); }
.settings-dot[data-tone="warning"] { background: var(--c-warning); }
.settings-dot[data-tone="muted"] { background: var(--c-text-3); }
.settings-list { display: flex; flex-direction: column; }
.settings-list-item { display: flex; align-items: center; gap: var(--space-8); min-height: var(--list-item-h); font-size: var(--font-size-sm); }
.settings-list-main { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-list-meta { color: var(--c-text-2); font-size: var(--font-size-xs); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-empty { display: flex; flex-direction: column; align-items: center; gap: var(--space-8); padding: var(--space-32); color: var(--c-text-2); text-align: center; font-size: var(--font-size-sm); }
.settings-empty-hint { color: var(--c-text-3); font-size: var(--font-size-xs); }
.settings-block-loading { display: flex; flex-direction: column; align-items: center; gap: var(--space-8); padding: var(--space-32); color: var(--c-text-2); font-size: var(--font-size-sm); }
.settings-breathe { width: 48px; height: 2px; background: var(--c-text-3); animation: settings-breathe var(--settings-breathe-dur) ease-in-out infinite; }
.settings-breathe-ring { width: var(--icon-sm); height: var(--icon-sm); border: var(--settings-ring-stroke) solid currentColor; border-radius: 50%; animation: settings-breathe var(--settings-breathe-dur) ease-in-out infinite; }
.settings-error { display: flex; align-items: center; gap: var(--space-8); padding: var(--space-8) var(--space-12); border-left: 3px solid var(--c-danger); background: var(--c-danger-bg); border-radius: var(--radius-sm); color: var(--c-danger); font-size: var(--font-size-sm); }
.settings-warning-bar { display: flex; align-items: center; gap: var(--space-8); padding: var(--space-8) var(--space-12); border-left: 3px solid var(--c-warning); background: var(--c-warning-bg); border-radius: var(--radius-sm); color: var(--c-warning); font-size: var(--font-size-sm); }
.settings-field { display: flex; flex-direction: column; gap: var(--space-4); margin-bottom: var(--space-12); font-size: var(--font-size-sm); }
.settings-field-label { color: var(--c-text-2); font-size: var(--font-size-xs); }
.settings-guide { position: fixed; inset: 0; z-index: var(--z-modal); display: flex; align-items: center; justify-content: center; background: var(--c-bg); }
.settings-guide-card { width: 100%; max-width: var(--guide-max-w); max-height: var(--settings-h); overflow: auto; padding: var(--space-24); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); }
.settings-guide-title { font-size: var(--font-size-xl); font-weight: var(--weight-strong); margin-bottom: var(--space-4); }
.settings-guide-intro { color: var(--c-text-2); font-size: var(--font-size-sm); margin-bottom: var(--space-24); }
.settings-guide-actions { display: flex; justify-content: flex-end; gap: var(--space-8); margin-top: var(--space-24); }
.settings-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.settings-model-picks { display: flex; flex-direction: column; gap: var(--space-4); max-height: var(--settings-picks-max-h); overflow: auto; }
.settings-check { display: flex; align-items: center; gap: var(--space-8); min-height: 24px; font-size: var(--font-size-sm); }
.settings-memory-entry { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-4) 0; }
.settings-memory-field { display: flex; align-items: baseline; gap: var(--space-8); font-size: var(--font-size-xs); }
.settings-memory-field .settings-list-meta { flex: 1 1 auto; }
.settings-memory-edit { display: flex; align-items: center; gap: var(--space-8); }
.settings-memory-edit .settings-input { flex: 1 1 auto; }
.settings-memory-expired, .settings-memory-expired .settings-list-main, .settings-memory-expired .settings-list-meta { color: var(--c-text-3); }
.settings-memory-hit { background: var(--c-selection); border-radius: var(--radius-sm); }
.settings-memory-pinned { color: var(--c-accent); font-size: var(--font-size-xs); }
@keyframes settings-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes settings-rise { from { opacity: 0; transform: translate(-50%, calc(-50% + 2px)); } to { opacity: 1; transform: translate(-50%, -50%); } }
@keyframes settings-tab-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes settings-breathe { 0%, 100% { opacity: .25; } 50% { opacity: .6; } }
@media (max-width: 767px) {
  .settings-modal { width: 100vw; height: 100vh; max-height: 100vh; left: 0; top: 0; transform: none; border-radius: 0; flex-direction: column; }
  .settings-nav { width: auto; flex-direction: row; overflow-x: auto; border-bottom: 1px solid var(--c-border); }
  .settings-nav-head { display: none; }
  .settings-tab { white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) {
  .settings-backdrop, .settings-modal, .settings-content-fade { animation: none; }
  .settings-breathe, .settings-breathe-ring { animation: none; opacity: .4; }
}
`

/** 幂等注入样式（同源 token 已由壳加载；此处只补组件样式）。 */
export function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  doc.head.appendChild(style)
}
