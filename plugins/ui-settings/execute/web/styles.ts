// 本插件的组件样式：只引用壳提供的 token（`/assets/tokens.v1.css`），零硬编码色值；
// 需要半透明处用 `color-mix(... var(--c-*) ...)` 由 token 派生，不写死 rgba / hex。
// 共享 token 未覆盖的组件规格（控件高 / 列表上限 / 呼吸时长 / 遮罩比 / 描边 / 语义点）以
// `.settings-root` 上的局部自定义属性收口，作**组件规格**登记，便于日后上收为全局 token。
// 引导页（`.settings-guide`）另登记自己的一档规格：更高的控件、更大的标题字阶、中性焦点环——
// 引导页只用黑 / 白 / 灰（不引 accent），居中单列，靠字阶、留白与发丝线立层级。
// 居中单列由 `.settings-guide-inner` 的 `margin: auto` 承担：内容短则垂直居中，长则从头排，不设固定顶距。

export const STYLE_ID = 'ui-settings-styles'

export const STYLE_TEXT = `
#slot-overlay > [data-slot-app="ui-settings"] { pointer-events: none; height: auto; }
.settings-root {
  --settings-control-h: 32px;
  --settings-frame-min-h: 104px;
  --settings-frame-max-h: 210px;
  --settings-breathe-dur: 1.6s;
  --settings-overlay-mix: 28%;
  --settings-ring-stroke: 1.5px;
  --settings-dot-size: 6px;
  --settings-focus-ring: 0 0 0 3px color-mix(in srgb, var(--c-text) 9%, transparent);
  position: fixed; inset: 0; z-index: var(--z-modal);
  pointer-events: auto;
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
.settings-input, .settings-select { min-height: var(--settings-control-h); padding: 0 var(--space-12); background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-md); color: var(--c-text); font: inherit; font-size: var(--font-size-sm); transition: border-color var(--motion-fast), box-shadow var(--motion-fast), background-color var(--motion-fast); }
.settings-input::placeholder { color: var(--c-text-3); }
.settings-input:hover, .settings-select:hover { border-color: color-mix(in srgb, var(--c-text-3) 55%, var(--c-border)); }
.settings-input:focus-visible, .settings-select:focus-visible { outline: none; border-color: var(--c-text-2); box-shadow: var(--settings-focus-ring); }
.settings-input[aria-invalid="true"] { border-color: var(--c-danger); }
.settings-input:disabled, .settings-select:disabled { opacity: .45; cursor: not-allowed; }
.settings-mono { font-family: var(--font-mono); }
.settings-select-wrap { position: relative; display: block; }
.settings-select-wrap .settings-select { appearance: none; -webkit-appearance: none; width: 100%; padding-right: var(--space-32); cursor: pointer; }
.settings-select-chevron { position: absolute; right: var(--space-12); top: 50%; transform: translateY(-50%); display: inline-flex; color: var(--c-text-3); pointer-events: none; transition: color var(--motion-fast); }
.settings-select-wrap:focus-within .settings-select-chevron, .settings-select-wrap:hover .settings-select-chevron { color: var(--c-text-2); }
.settings-btn { display: inline-flex; align-items: center; gap: var(--space-4); min-height: var(--settings-control-h); padding: 0 var(--space-12); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); color: var(--c-text); font: inherit; font-size: var(--font-size-sm); cursor: pointer; transition: background-color var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast), box-shadow var(--motion-fast); }
.settings-btn:hover { background: var(--c-selection); border-color: color-mix(in srgb, var(--c-text-3) 45%, var(--c-border)); }
.settings-btn:active { background: var(--c-border); }
.settings-btn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.settings-btn:disabled { opacity: .45; cursor: not-allowed; }
.settings-btn[data-tone="danger"] { color: var(--c-danger); }
.settings-btn[data-tone="accent"] { background: var(--c-accent); border-color: var(--c-accent); color: var(--c-accent-text); }
.settings-btn[data-tone="accent"]:hover { filter: brightness(1.06); }
.settings-btn[data-tone="accent"]:disabled { background: var(--c-selection); border-color: var(--c-border); color: var(--c-text-3); opacity: 1; filter: none; }
.settings-btn[data-tone="ink"] { background: var(--c-text); border-color: var(--c-text); color: var(--c-bg); }
.settings-btn[data-tone="ink"]:hover { background: color-mix(in srgb, var(--c-text) 88%, var(--c-bg)); border-color: transparent; }
.settings-btn[data-tone="ink"]:active { background: color-mix(in srgb, var(--c-text) 76%, var(--c-bg)); }
.settings-btn[data-tone="ink"]:disabled { background: var(--c-selection); border-color: var(--c-border); color: var(--c-text-3); opacity: 1; }
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
.settings-field { display: flex; flex-direction: column; gap: var(--space-8); margin-bottom: var(--space-16); font-size: var(--font-size-sm); max-width: var(--settings-field-max-w, none); }
.settings-field-label { color: var(--c-text-2); font-size: var(--font-size-xs); font-weight: var(--weight-medium); }
.settings-form-fields .settings-field-label { text-transform: uppercase; letter-spacing: .06em; }
.settings-required-mark { color: var(--c-text-3); margin-left: 2px; }
.settings-field-error { color: var(--c-danger); font-size: var(--font-size-xs); margin-top: var(--space-4); }
.settings-field-error[hidden] { display: none; }
.settings-form-section + .settings-form-section { margin-top: var(--space-32); padding-top: var(--space-24); border-top: 1px solid var(--c-border); }
.settings-form-section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-12); margin-bottom: var(--space-16); }
.settings-form-section-title { display: flex; align-items: center; gap: var(--space-8); color: var(--c-text); font-size: var(--font-size-md); font-weight: var(--weight-strong); }
.settings-form-section-action { flex: none; }
.settings-form-fields { display: flex; flex-direction: column; }
.settings-form-fields [hidden] { display: none; }
.settings-subentry-btn { align-self: flex-start; border-style: dashed; color: var(--c-text-2); background: none; }
.settings-subentry-btn:hover { color: var(--c-text); border-color: var(--c-text-3); background: var(--c-selection); }

.settings-guide {
  --settings-control-h: 34px;
  --guide-main-w: 560px;
  --guide-title-size: 24px;
  position: fixed; inset: 0; z-index: var(--z-modal);
  display: flex; flex-direction: column;
  background: var(--c-bg);
  pointer-events: auto;
  overflow: auto;
  scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--c-text) 22%, transparent) transparent;
}
.settings-guide::-webkit-scrollbar { width: 10px; }
.settings-guide::-webkit-scrollbar-track { background: transparent; }
.settings-guide::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--c-text) 16%, transparent); border: 3px solid transparent; border-radius: 999px; background-clip: content-box; }
.settings-guide::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--c-text) 30%, transparent); background-clip: content-box; }
.settings-guide-inner { width: 100%; max-width: calc(var(--guide-main-w) + var(--space-32) * 2); margin: auto; padding: var(--space-24) var(--space-32); }
.settings-guide-inner > * { animation: settings-rise-in var(--motion-slow) both; }
.settings-guide-inner > *:nth-child(2) { animation-delay: 40ms; }
.settings-guide-inner > *:nth-child(3) { animation-delay: 80ms; }
.settings-guide-inner > *:nth-child(n+4) { animation-delay: 120ms; }

.settings-guide-hero { margin: 0 0 var(--space-24); }
.settings-guide-eyebrow { color: var(--c-text-3); font-size: var(--font-size-xs); font-weight: var(--weight-medium); letter-spacing: .12em; }
.settings-guide-hero-title { margin-top: var(--space-8); color: var(--c-text); font-size: var(--guide-title-size); font-weight: var(--weight-strong); letter-spacing: -.02em; line-height: 1.3; }
.settings-guide-hero-title:first-child { margin-top: 0; }
.settings-guide-hero-sub { margin-top: var(--space-8); color: var(--c-text-2); font-size: var(--font-size-sm); }
.settings-guide .settings-form-section + .settings-form-section { margin-top: var(--space-24); padding-top: var(--space-16); }
.settings-guide .settings-entry { padding: var(--space-12) var(--space-16); }
.settings-guide .settings-entry-icon { width: 36px; height: 36px; }
.settings-guide .settings-guide-actions { margin-top: var(--space-24); padding-top: var(--space-16); }
.settings-guide .settings-guide-actions .settings-btn { padding: 0 var(--space-16); }
.settings-guide .settings-guide-actions .settings-btn[data-tone="ink"] { padding: 0 var(--space-24); }
.settings-guide-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-8); margin-top: var(--space-24); padding-top: var(--space-16); border-top: 1px solid var(--c-border); }
.settings-action-lead { margin-right: auto; }

.settings-entry-list { display: flex; flex-direction: column; gap: var(--space-12); }
.settings-entry { display: flex; align-items: center; gap: var(--space-16); width: 100%; padding: var(--space-16); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-lg); color: var(--c-text); font: inherit; text-align: left; cursor: pointer; transition: border-color var(--motion-fast), background-color var(--motion-fast), box-shadow var(--motion-fast), transform var(--motion-fast); }
.settings-entry:not(:disabled):hover { border-color: var(--c-text-3); box-shadow: var(--shadow-soft); transform: translateY(-1px); }
.settings-entry:not(:disabled):active { transform: none; }
.settings-entry:focus-visible { outline: none; border-color: var(--c-text-2); box-shadow: var(--settings-focus-ring); }
.settings-entry:disabled { opacity: .5; cursor: not-allowed; }
.settings-entry-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--c-border); border-radius: var(--radius-md); background: var(--c-bg); color: var(--c-text); transition: background-color var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast); }
.settings-entry:not(:disabled):hover .settings-entry-icon { background: var(--c-text); border-color: var(--c-text); color: var(--c-bg); }
.settings-entry-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.settings-entry-label { font-size: var(--font-size-md); font-weight: var(--weight-medium); }
.settings-entry-hint { color: var(--c-text-3); font-size: var(--font-size-xs); }
.settings-entry-chevron { flex: none; display: inline-flex; color: var(--c-text-3); transition: transform var(--motion-fast), color var(--motion-fast); }
.settings-entry:not(:disabled):hover .settings-entry-chevron { color: var(--c-text-2); transform: translateX(2px); }

.settings-models-fetch { min-height: 30px; padding: 0 var(--space-8); color: var(--c-text-2); font-size: var(--font-size-xs); }
.settings-models-fetch:hover { color: var(--c-text); }

.settings-models-bar { display: flex; align-items: center; gap: var(--space-8); min-height: 26px; margin-bottom: var(--space-8); color: var(--c-text-2); font-size: var(--font-size-xs); transition: opacity var(--motion-fast); }
.settings-models-count { font-variant-numeric: tabular-nums; }
.settings-models-actions { margin-left: auto; display: inline-flex; gap: var(--space-4); }
.settings-models-actions .settings-btn { min-height: 24px; padding: 0 var(--space-8); background: none; border-color: transparent; color: var(--c-text-2); }
.settings-models-actions .settings-btn:hover { background: var(--c-selection); border-color: transparent; color: var(--c-text); }
.settings-model-filter { display: inline-flex; align-items: center; }
.settings-model-filter[hidden] { display: none; }
.settings-model-filter .settings-input { width: 168px; min-height: 26px; height: 26px; padding: 0 var(--space-8); font-size: var(--font-size-xs); }
.settings-model-filter .settings-input[hidden] { display: none; }
.settings-models-bar[data-empty="true"] { opacity: 0; visibility: hidden; }
.settings-model-frame { display: flex; flex-direction: column; min-height: var(--settings-frame-min-h); max-height: var(--settings-frame-max-h); overflow: auto; border: 1px solid var(--c-border); border-radius: var(--radius-md); background: var(--c-bg); }
.settings-model-list { display: flex; flex-direction: column; flex: 1 1 auto; }
.settings-model-list .settings-check { padding: 0 var(--space-8); }
.settings-model-list .settings-check-in { animation: settings-rise-in var(--motion-base) both; }
.settings-model-empty { margin: auto; padding: var(--space-16); color: var(--c-text-3); text-align: center; font-size: var(--font-size-sm); }
.settings-check { display: flex; align-items: center; gap: var(--space-8); min-height: 34px; padding: 0 var(--space-4); border-bottom: 1px solid var(--c-border); border-radius: var(--radius-sm); font-size: var(--font-size-sm); cursor: pointer; transition: background-color var(--motion-fast); }
.settings-check:last-child { border-bottom-color: transparent; }
.settings-check:hover { background: var(--c-selection); }
.settings-check-main { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--font-size-xs); }
.settings-check input[type="checkbox"] { appearance: none; -webkit-appearance: none; position: relative; flex: none; width: 16px; height: 16px; margin: 0; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 4px; cursor: pointer; transition: background-color var(--motion-fast), border-color var(--motion-fast); }
.settings-check input[type="checkbox"]:hover { border-color: var(--c-text-3); }
.settings-check input[type="checkbox"]:checked { background: var(--c-text); border-color: var(--c-text); }
.settings-check input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 5px; top: 2px; width: 3px; height: 7px; border: solid var(--c-bg); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.settings-check input[type="checkbox"]:focus-visible { outline: none; box-shadow: var(--settings-focus-ring); }
.settings-custom-entry { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-12); margin-top: var(--space-12); padding-top: var(--space-12); border-top: 1px solid var(--c-border); }
.settings-custom-model { display: flex; align-items: center; gap: var(--space-8); width: 100%; }
.settings-custom-model .settings-input { flex: 1 1 auto; }
.settings-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.settings-memory-entry { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-4) 0; }
.settings-memory-field { display: flex; align-items: baseline; gap: var(--space-8); font-size: var(--font-size-xs); }
.settings-memory-field .settings-list-meta { flex: 1 1 auto; }
.settings-memory-edit { display: flex; align-items: center; gap: var(--space-8); }
.settings-memory-edit .settings-input { flex: 1 1 auto; }
.settings-memory-expired, .settings-memory-expired .settings-list-main, .settings-memory-expired .settings-list-meta { color: var(--c-text-3); }
.settings-memory-hit { background: var(--c-selection); border-radius: var(--radius-sm); }
.settings-memory-pinned { color: var(--c-accent); font-size: var(--font-size-xs); }
@keyframes settings-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes settings-rise-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes settings-rise { from { opacity: 0; transform: translate(-50%, calc(-50% + 2px)); } to { opacity: 1; transform: translate(-50%, -50%); } }
@keyframes settings-tab-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes settings-breathe { 0%, 100% { opacity: .25; } 50% { opacity: .6; } }
@media (max-width: 767px) {
  .settings-modal { width: 100vw; height: 100vh; max-height: 100vh; left: 0; top: 0; transform: none; border-radius: 0; flex-direction: column; }
  .settings-nav { width: auto; flex-direction: row; overflow-x: auto; border-bottom: 1px solid var(--c-border); }
  .settings-nav-head { display: none; }
  .settings-tab { white-space: nowrap; }
  .settings-guide { --guide-title-size: 26px; }
  .settings-guide-inner { max-width: none; margin: 0; padding: var(--space-24) var(--space-16) var(--space-32); }
}
@media (prefers-reduced-motion: reduce) {
  .settings-backdrop, .settings-modal, .settings-content-fade, .settings-guide-inner > *, .settings-check-in { animation: none; }
  .settings-breathe, .settings-breathe-ring { animation: none; opacity: .4; }
}
`

/** 幂等注入样式（同源 token 已由壳加载；此处只补组件样式）。 */
export function ensureStyles(doc: any): void {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  doc.head.appendChild(style)
}
