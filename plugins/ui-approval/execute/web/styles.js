// 审批停靠带样式：只引壳的 token（tokens.v1.css），零硬编码色值；薄玻璃为全局唯一例外。
// 无待审批项时不渲染（0 高度由入口控制）；层级用 --z-dock（弹层之上、横幅 / toast 之下）。

const STYLE_ID = 'approval-dock-styles'

export const DOCK_CSS = `
.approval-root {
  position: relative;
  z-index: var(--z-dock);
  pointer-events: none;
}
.approval-dock {
  pointer-events: auto;
  background: var(--c-glass);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  max-height: 40vh;
  overflow-y: auto;
  animation: approval-dock-in var(--motion-slow);
}
@supports not ((backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px))) {
  .approval-dock { background: var(--c-surface); }
}
@keyframes approval-dock-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.approval-head {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-12);
  border-bottom: 1px solid var(--c-border);
}
.approval-head-count {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--c-text-2);
  font-size: var(--font-size-xs);
}
.approval-head-count strong { color: var(--c-text); font-weight: var(--weight-strong); }
.approval-head-wait {
  color: var(--c-text-3);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
.approval-head-wait[data-warn="true"] { color: var(--c-warning); }
.approval-head-spacer { flex: 1; }
.approval-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 28px;
  padding: 0 var(--space-8);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.approval-btn:hover { background: var(--c-selection); }
.approval-btn:active { background: var(--c-border); }
.approval-btn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.approval-btn:disabled { opacity: .45; cursor: not-allowed; }
.approval-btn[data-tone="accent"] {
  background: var(--c-accent);
  border-color: var(--c-accent);
  color: var(--c-accent-text);
}
.approval-btn[data-tone="accent"]:hover { filter: brightness(1.06); }
.approval-btn[data-tone="danger"] { color: var(--c-danger); }
.approval-btn[data-tone="danger"]:hover { background: var(--c-danger-bg); }
.approval-btn[data-armed="true"] {
  background: var(--c-warning-bg);
  border-color: var(--c-warning);
  color: var(--c-warning);
}
.approval-btn[data-busy="true"] { color: var(--c-text-3); }
.approval-breathe-ring {
  flex: none;
  width: var(--icon-sm);
  height: var(--icon-sm);
  border: 1.5px solid currentColor;
  border-radius: 50%;
  animation: approval-breathe 1.6s ease-in-out infinite;
}
@keyframes approval-breathe {
  0%, 100% { opacity: .25; }
  50% { opacity: .6; }
}
.approval-list { display: flex; flex-direction: column; }
.approval-item {
  position: relative;
  padding: var(--space-8) var(--space-12) var(--space-8) var(--space-12);
  border-left: 3px solid var(--c-warning);
  border-bottom: 1px solid var(--c-border);
  animation: approval-item-in var(--motion-base);
}
.approval-item:last-child { border-bottom: 0; }
@keyframes approval-item-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.approval-item[data-tone="expired"] { color: var(--c-text-3); }
.approval-item-main { display: flex; align-items: center; gap: var(--space-8); }
.approval-item-toggle {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
  min-height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.approval-item-toggle:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.approval-item-tool { color: var(--c-text-2); font-size: var(--font-size-xs); white-space: nowrap; }
.approval-item[data-tone="expired"] .approval-item-tool { color: var(--c-text-3); }
.approval-item-summary {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: var(--leading-code);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.approval-item-actions { display: inline-flex; gap: var(--space-4); }
.approval-item-actions .approval-btn { min-height: 24px; }
.approval-item-detail {
  margin-top: var(--space-8);
  padding: var(--space-8);
  background: var(--c-bg);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: var(--leading-code);
  color: var(--c-text);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  max-height: 200px;
  overflow: auto;
}
.approval-item-detail[hidden] { display: none; }
.approval-tag {
  color: var(--c-warning);
  font-size: var(--font-size-xs);
}
.approval-note { color: var(--c-text-2); font-size: var(--font-size-xs); }
.approval-note[data-tone="success"] { color: var(--c-success); }
.approval-note[data-tone="warning"] { color: var(--c-warning); }
.approval-note[data-tone="danger"] { color: var(--c-danger); }
.approval-shadow { margin-top: var(--space-8); }
.approval-shadow-title { color: var(--c-text-2); font-size: var(--font-size-xs); }
.approval-shadow-rows { display: flex; flex-wrap: wrap; gap: var(--space-12); margin-top: var(--space-4); }
.approval-shadow-row { display: inline-flex; gap: var(--space-4); font-size: var(--font-size-xs); color: var(--c-text-2); }
.approval-shadow-row .from { color: var(--c-text-3); }
.approval-shadow-row .delta[data-tone="success"] { color: var(--c-success); }
.approval-shadow-row .delta[data-tone="warning"] { color: var(--c-warning); }
.approval-shadow-row .delta[data-tone="muted"] { color: var(--c-text-3); }
.approval-danger-inline { color: var(--c-danger); font-size: var(--font-size-xs); }
.approval-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  border: 0;
}
@media (prefers-reduced-motion: reduce) {
  .approval-dock, .approval-item { animation: none; }
  .approval-breathe-ring { animation: none; opacity: .4; }
}
`

/** 注入本插件样式（幂等）：只引 token，样式表住本插件自己的子应用。 */
export function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = DOCK_CSS
  doc.head.appendChild(style)
}
