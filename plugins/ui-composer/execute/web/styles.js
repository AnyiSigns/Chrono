// Composer styles: only shell tokens (tokens.v1.css), zero hardcoded colors.
// Focus = deeper border + accent 8% ring, one-shot 150ms fade-in; accent only on send.

const STYLE_ID = 'composer-styles'

export const COMPOSER_CSS = `
.composer-root {
  position: relative;
  padding: var(--space-8) var(--space-12);
  font-family: var(--font-sans);
}
@media (min-width: 768px) {
  .composer-root { padding-left: var(--space-16); padding-right: var(--space-16); }
}
.composer-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  background: transparent;
}
.composer-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-12);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-xl);
  transition: border-color var(--motion-fast), box-shadow var(--motion-fast);
}
.composer-card:hover { border-color: var(--c-text-3); }
.composer-card[data-focus="true"] {
  border-color: var(--c-text-3);
  box-shadow: var(--focus-ring);
  animation: composer-focus-in var(--motion-base);
}
@keyframes composer-focus-in {
  from { box-shadow: 0 0 0 0 transparent; }
  to { box-shadow: var(--focus-ring); }
}
.composer-card[data-dragover="true"] { border-color: var(--c-text-3); }
.composer-input {
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: var(--c-text);
  font: inherit;
  font-size: var(--font-size-md);
  line-height: var(--leading-body);
  min-height: 40px;
  max-height: var(--composer-max-h);
  overflow-y: auto;
  padding: var(--space-4) 0;
}
.composer-input::placeholder { color: var(--c-text-3); }
.composer-input:disabled { opacity: .45; cursor: not-allowed; }
.composer-attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
}
.composer-attach-row[hidden] { display: none; }
.composer-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  max-width: 200px;
  min-height: 24px;
  padding: var(--space-4);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-text-2);
  font-size: var(--font-size-xs);
}
.composer-chip[data-kind="image"][data-status="ready"] { width: 40px; height: 40px; padding: 0; overflow: hidden; }
.composer-chip-thumb { width: 100%; height: 100%; object-fit: cover; border-radius: var(--radius-sm); }
.composer-chip-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-chip[data-status="failed"] { border-color: var(--c-danger); cursor: pointer; }
.composer-chip[data-status="loading"]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  opacity: .4;
}
.composer-chip-breathe {
  flex: none;
  width: var(--icon-sm);
  height: var(--icon-sm);
  border: 1.5px solid currentColor;
  border-radius: 50%;
  animation: composer-breathe 1.6s ease-in-out infinite;
}
.composer-chip-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--c-surface);
  color: var(--c-text-2);
  opacity: 0;
  cursor: pointer;
  transition: opacity var(--motion-fast);
}
.composer-chip:hover .composer-chip-remove,
.composer-chip:focus-within .composer-chip-remove { opacity: 1; }
.composer-chip-remove:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.composer-toolbar { display: flex; align-items: center; gap: var(--space-4); }
.composer-toolbar-left { display: flex; align-items: center; gap: var(--space-4); flex: 1; min-width: 0; }
.composer-toolbar-right { display: flex; align-items: center; gap: var(--space-4); }
.composer-tool {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 32px;
  min-height: 32px;
  padding: 0 var(--space-8);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background-color var(--motion-fast);
}
.composer-tool:hover { background: var(--c-selection); }
.composer-tool:active { background: var(--c-border); }
.composer-tool:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.composer-tool:disabled { opacity: .45; cursor: not-allowed; }
.composer-tool[hidden] { display: none; }
.composer-tool-value { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-tool-chevron { color: var(--c-text-3); }
@media (max-width: 479px) {
  .composer-tool-value { display: none; }
}
.composer-inline-error {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--c-danger);
  font-size: var(--font-size-xs);
}
.composer-inline-error[hidden] { display: none; }
.composer-inline-retry {
  min-height: 24px;
  padding: 0 var(--space-8);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-danger);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.composer-inline-retry:hover { background: var(--c-danger-bg); }
.composer-inline-retry:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.composer-send {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--c-accent);
  color: var(--c-accent-text);
  cursor: pointer;
}
.composer-send:hover { filter: brightness(1.06); }
.composer-send:active { filter: brightness(.94); }
.composer-send:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.composer-send:disabled { opacity: .45; cursor: not-allowed; }
.composer-send-icon {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity var(--motion-fast);
}
.composer-send[data-mode="send"] .composer-send-icon[data-icon="stop"],
.composer-send[data-mode="stop"] .composer-send-icon[data-icon="send"] { opacity: 0; }
.composer-send[data-mode="stop"] .composer-send-icon[data-icon="stop"] {
  animation: composer-breathe 1.6s ease-in-out infinite;
}
@keyframes composer-breathe {
  0%, 100% { opacity: .35; }
  50% { opacity: .85; }
}
.composer-context {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-4) 0;
  color: var(--c-text-3);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
.composer-context[hidden] { display: none; }
.composer-context[data-tone="warning"] { color: var(--c-warning); }
.composer-context[data-tone="danger"] { color: var(--c-danger); }
.composer-pending-wrap {
  position: absolute;
  top: 0;
  right: var(--space-16);
  z-index: var(--z-popover);
  transform: translateY(-50%);
}
.composer-pending-wrap .composer-popover[data-placement="below"] { left: auto; right: 0; }
.composer-pending {
  position: relative;
  min-height: 24px;
  padding: 0 var(--space-8);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-selection);
  color: var(--c-text-2);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background-color var(--motion-fast);
}
.composer-pending:hover { background: var(--c-border); }
.composer-pending:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.composer-pending[hidden] { display: none; }
.composer-popover {
  position: absolute;
  z-index: var(--z-popover);
  min-width: 180px;
  max-width: 280px;
  max-height: 240px;
  overflow-y: auto;
  padding: var(--space-4);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  animation: composer-pop-in var(--motion-fast);
}
.composer-popover[hidden] { display: none; }
.composer-popover[data-placement="above"] { bottom: 100%; left: 0; margin-bottom: var(--space-4); }
.composer-popover[data-placement="below"] { top: 100%; left: 0; margin-top: var(--space-4); }
.composer-popover[data-placement="right"] { top: 0; right: 100%; margin-right: var(--space-4); }
@keyframes composer-pop-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
.composer-option {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 24px;
  padding: var(--space-4) var(--space-8);
  border-radius: var(--radius-sm);
  color: var(--c-text);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.composer-option:hover { background: var(--c-selection); }
.composer-option[data-active="true"] { background: var(--c-selection); }
.composer-option[aria-selected="true"] { font-weight: var(--weight-strong); }
.composer-option-icon { color: var(--c-text-2); }
.composer-option-body { display: flex; flex-direction: column; min-width: 0; }
.composer-option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-option-desc { color: var(--c-text-3); font-size: var(--font-size-xs); }
.composer-popover-title { padding: var(--space-4) var(--space-8); color: var(--c-text-2); font-size: var(--font-size-xs); }
.composer-popover-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-4) var(--space-8);
  color: var(--c-text);
  font-size: var(--font-size-xs);
}
.composer-popover-row-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-popover-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
}
.composer-popover-remove:hover { background: var(--c-selection); }
.composer-popover-remove:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.composer-tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-12);
  padding: var(--space-4) var(--space-8);
  color: var(--c-text-2);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
.composer-tooltip-note { padding: var(--space-4) var(--space-8); color: var(--c-text-3); font-size: var(--font-size-xs); }
@media (prefers-reduced-motion: reduce) {
  .composer-card,
  .composer-card[data-focus="true"],
  .composer-chip-breathe,
  .composer-popover,
  .composer-send[data-mode="stop"] .composer-send-icon[data-icon="stop"] {
    animation: none;
  }
  .composer-chip-breathe { opacity: .4; }
  .composer-send[data-mode="stop"] .composer-send-icon[data-icon="stop"] { opacity: 1; }
}
`

/** 注入本插件样式（幂等）：只引 token，样式表住本插件自己的子应用。 */
export function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = COMPOSER_CSS
  doc.head.appendChild(style)
}
