// Approval dock styles: shell tokens only (tokens.v1.css), zero hardcoded colors.
// Injected by entry.tsx as <style> with the component tree (no mount-time ensureStyles).
// Layout intent (kept out of the CSS template so no Chinese leaks into web source):
// - .approval-root mirrors .composer-root (max-width: --msg-max-w, centered, space-16 sides)
//   so the dock sits directly above the input card with matching left/right edges.
// - Stacked deck (default for 2+ items): the front card is full size; up to two cards behind
//   peek out above it, each narrower and dimmer by depth (iOS notification-stack look).
//   The peeks container reserves only the visible band height; peek bodies spill onto the
//   front card and are covered by its opaque surface + higher z-index.
// - Fan-out (toggle in the head or tap the peeks) renders the flat list with plain gaps.
// - Glass is the one global exception (--c-glass + backdrop blur), with a solid fallback.

export const STYLE_TEXT = `
.approval-root {
  box-sizing: border-box;
  max-width: var(--msg-max-w);
  margin: 0 auto;
  padding: var(--space-8) var(--space-16) 0;
  font-family: var(--font-sans);
}
.approval-dock {
  display: flex;
  flex-direction: column;
  animation: approval-dock-in var(--motion-slow);
}
@keyframes approval-dock-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.approval-head {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: 0 var(--space-4) var(--space-8);
}
.approval-head-count {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 24px;
  padding: 0 var(--space-8);
  border-radius: 999px;
  background: var(--c-selection);
  color: var(--c-text-2);
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
}
.approval-head-count svg { color: var(--c-text-2); }
.approval-head-wait {
  color: var(--c-text-3);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
.approval-head-wait[data-warn="true"] { color: var(--c-warning); }
.approval-head-spacer { flex: 1; }
.approval-fan {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  transition: background-color var(--motion-fast), color var(--motion-fast);
}
.approval-fan:hover { background: var(--c-selection); color: var(--c-text); }
.approval-fan:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.approval-fan svg { transition: transform var(--motion-fast); }
.approval-fan[data-open="true"] svg { transform: rotate(180deg); }
.approval-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 28px;
  padding: 0 var(--space-12);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-text);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background-color var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast);
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
.approval-btn[data-tone="accent"]:active { filter: brightness(.94); }
.approval-btn[data-tone="danger"] { color: var(--c-danger); }
.approval-btn[data-tone="danger"]:hover { background: var(--c-danger-bg); }
.approval-btn[data-armed="true"] {
  background: var(--c-warning-bg);
  border-color: var(--c-warning);
  color: var(--c-warning);
  font-weight: var(--weight-strong);
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
  50% { opacity: .65; }
}
.approval-loading {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-12) var(--space-16);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  background: var(--c-glass);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--shadow-soft);
  color: var(--c-text-3);
  font-size: var(--font-size-xs);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .approval-loading { background: var(--c-surface); }
}
.approval-loading-note { color: var(--c-text-3); }
.approval-list { display: flex; flex-direction: column; gap: var(--space-8); }
.approval-deck { position: relative; }
.approval-deck > .approval-item { z-index: 5; }
.approval-peeks { position: relative; cursor: pointer; user-select: none; }
.approval-peeks[data-depths="1"] { height: 14px; }
.approval-peeks[data-depths="2"] { height: 26px; }
.approval-peek {
  position: absolute;
  left: 0;
  right: 0;
  height: 26px;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  gap: var(--space-8);
  padding: var(--space-4) var(--space-12);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-soft);
  font-size: var(--font-size-xs);
  line-height: var(--leading-code);
  animation: approval-peek-in var(--motion-base);
  transition: top var(--motion-fast), opacity var(--motion-fast);
}
@keyframes approval-peek-in {
  from { transform: translateY(6px); }
  to { transform: none; }
}
.approval-peek[data-depth="1"] { top: 12px; left: 8px; right: 8px; z-index: 2; opacity: .85; }
.approval-peek[data-depth="2"] { top: 0; left: 16px; right: 16px; z-index: 1; opacity: .6; }
.approval-peeks[data-depths="1"] .approval-peek[data-depth="1"] { top: 0; }
.approval-peeks[data-depths="2"]:hover .approval-peek[data-depth="1"] { top: 13px; }
.approval-peeks:hover .approval-peek[data-depth="1"] { opacity: 1; }
.approval-peeks:hover .approval-peek[data-depth="2"] { opacity: .75; }
.approval-item {
  position: relative;
  z-index: 1;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-soft);
  animation: approval-item-in var(--motion-base);
  transition: box-shadow var(--motion-fast), transform var(--motion-fast), border-color var(--motion-fast);
}
.approval-item:hover,
.approval-item:focus-within {
  z-index: 6;
  transform: translateY(-2px);
  border-color: var(--c-text-3);
  box-shadow: var(--shadow-pop);
}
.approval-item[data-tone="expired"] { opacity: .62; }
.approval-item::before,
.approval-peek::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: var(--radius-lg) 0 0 var(--radius-lg);
  background: var(--c-warning);
}
.approval-item[data-kind="plugin_write"]::before,
.approval-peek[data-kind="plugin_write"]::before { background: var(--c-danger); }
.approval-item[data-kind="orchestration_change"]::before,
.approval-peek[data-kind="orchestration_change"]::before { background: var(--c-info); }
.approval-item[data-tone="expired"]::before,
.approval-peek[data-tone="expired"]::before { background: var(--c-text-3); }
@keyframes approval-item-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.approval-item-main {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-12) var(--space-8) var(--space-16);
}
.approval-item-toggle {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
  min-width: 0;
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
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: var(--leading-code);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.approval-item-actions { display: inline-flex; gap: var(--space-4); flex: none; }
.approval-item-actions .approval-btn { min-height: 24px; }
.approval-item-detail {
  margin: 0 var(--space-12) var(--space-8) var(--space-16);
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
.approval-tag {
  color: var(--c-warning);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}
.approval-note { color: var(--c-text-2); font-size: var(--font-size-xs); }
.approval-note[data-tone="success"] { color: var(--c-success); }
.approval-note[data-tone="warning"] { color: var(--c-warning); }
.approval-note[data-tone="danger"] { color: var(--c-danger); }
.approval-shadow-title { color: var(--c-text-2); font-size: var(--font-size-xs); }
.approval-shadow-rows { display: flex; flex-wrap: wrap; gap: var(--space-12); }
.approval-shadow-row { display: inline-flex; gap: var(--space-4); font-size: var(--font-size-xs); color: var(--c-text-2); }
.approval-shadow-row .label { color: var(--c-text-3); }
.approval-shadow-row .from { color: var(--c-text-3); }
.approval-shadow-row .delta[data-tone="success"] { color: var(--c-success); }
.approval-shadow-row .delta[data-tone="warning"] { color: var(--c-warning); }
.approval-shadow-row .delta[data-tone="muted"] { color: var(--c-text-3); }
.approval-danger-inline {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-12) var(--space-8) var(--space-16);
  color: var(--c-danger);
  font-size: var(--font-size-xs);
}
.approval-item .approval-danger-inline { padding: 0 var(--space-12) var(--space-8) var(--space-16); }
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
  .approval-dock, .approval-item, .approval-peek { animation: none; }
  .approval-breathe-ring { animation: none; opacity: .4; }
}
`
