// 侧栏样式：只用共享 token（`/assets/tokens.v1.css`），不硬编码色值。
// 通过 `ensureStyles(doc)` 注入一次；类名统一 `sb-` 前缀。

const STYLE_ID = 'ui-sidebar-styles'

const CSS = `
.sb-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  width: var(--sb-width, 260px);
  box-sizing: border-box;
  background: var(--c-sidebar);
  color: var(--c-text);
  font-size: var(--font-size-md);
  line-height: var(--leading-body);
  position: relative;
  overflow: hidden;
}
.sb-root[data-dragging="true"] { transition: none; }
.sb-root:not([data-dragging="true"]) { transition: width var(--motion-base); }
.sb-root[data-collapsed="true"] { --sb-width: 56px; }

.sb-head {
  padding: var(--space-12) var(--space-12) var(--space-8);
  font-size: var(--font-size-xl);
  font-weight: var(--weight-strong);
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
}
.sb-root[data-collapsed="true"] .sb-head { text-align: center; font-size: var(--font-size-lg); }

.sb-search { padding: 0 var(--space-8) var(--space-8); }
.sb-search-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  height: 34px;
  padding: 0 var(--space-8);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  color: var(--c-text-3);
  background: var(--c-surface);
}
.sb-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--c-text);
  font-size: var(--font-size-md);
}
.sb-root[data-collapsed="true"] .sb-search { display: none; }

.sb-add {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  height: 34px;
  margin: 0 var(--space-8) var(--space-8);
  padding: 0 var(--space-8);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--font-size-md);
  cursor: pointer;
  text-align: left;
}
.sb-add:hover { background: var(--c-selection); color: var(--c-text); }
.sb-add:disabled { opacity: 0.45; cursor: not-allowed; }
.sb-root[data-collapsed="true"] .sb-add { justify-content: center; padding: 0; margin: 0 auto var(--space-8); width: 40px; }
.sb-root[data-collapsed="true"] .sb-add .sb-label { display: none; }

.sb-list { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: var(--space-8); }
.sb-empty { padding: var(--space-24) var(--space-12); color: var(--c-text-2); font-size: var(--font-size-sm); text-align: center; }
.sb-empty-title { color: var(--c-text-2); }
.sb-empty-hint { margin-top: var(--space-4); color: var(--c-text-3); }

.sb-group { margin-bottom: var(--space-4); }
.sb-group-head {
  display: flex;
  align-items: center;
  height: 30px;
  padding-right: var(--space-4);
  color: var(--c-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.sb-group-head:hover { background: var(--c-selection); }
.sb-group-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-group-head[data-missing="true"] .sb-group-name { color: var(--c-text-3); }
.sb-missing-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-danger); flex: none; }
.sb-group-actions { display: flex; align-items: center; gap: var(--space-4); opacity: 0; }
.sb-group-head:hover .sb-group-actions, .sb-group-head:focus-within .sb-group-actions { opacity: 1; }
.sb-group-actions[data-persist="true"] { opacity: 1; }

.sb-session {
  display: flex;
  align-items: center;
  height: 34px;
  padding-left: 20px;
  padding-right: var(--space-4);
  border-radius: var(--radius-md);
  color: var(--c-text-2);
  cursor: pointer;
}
.sb-session:hover { background: var(--c-selection); }
.sb-session[data-current="true"] { background: var(--c-selection); color: var(--c-text); }
.sb-session-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-md); }
.sb-session-actions { display: flex; align-items: center; gap: var(--space-4); opacity: 0; }
.sb-session:hover .sb-session-actions, .sb-session:focus-within .sb-session-actions { opacity: 1; }
.sb-session-rename {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-text);
  font-size: var(--font-size-md);
  padding: 2px var(--space-4);
}
.sb-confirm { display: flex; align-items: center; gap: var(--space-8); flex: 1; color: var(--c-danger); font-size: var(--font-size-sm); }
.sb-confirm button { border: none; background: transparent; color: inherit; cursor: pointer; font-size: var(--font-size-sm); }
.sb-confirm button[data-primary="true"] { color: var(--c-danger); font-weight: var(--weight-strong); }

.sb-badge { flex: none; display: inline-flex; align-items: center; gap: var(--space-4); }
.sb-dot { width: 6px; height: 6px; border-radius: 50%; }
.sb-dot[data-kind="running"] { background: var(--c-accent); animation: sb-breathe 1.6s ease-in-out infinite; }
.sb-dot[data-kind="pending"] { background: var(--c-warning); }
.sb-dot[data-kind="failed"] { background: var(--c-danger); }
.sb-unread { font-size: var(--font-size-xs); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
@keyframes sb-breathe { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.6; } }
@media (prefers-reduced-motion: reduce) { .sb-dot[data-kind="running"] { animation: none; opacity: 0.5; } }

.sb-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  flex: none;
}
.sb-iconbtn:hover { background: var(--c-selection); color: var(--c-text); }
.sb-iconbtn:disabled { opacity: 0.45; cursor: not-allowed; }
.sb-iconbtn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.sb-iconbtn[data-danger="true"] { color: var(--c-danger); }

.sb-foot {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-8);
  border-top: 1px solid var(--c-border);
}
.sb-settings {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  flex: 1;
  height: 34px;
  padding: 0 var(--space-8);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--font-size-md);
  cursor: pointer;
}
.sb-settings:hover { background: var(--c-selection); color: var(--c-text); }
.sb-root[data-collapsed="true"] .sb-settings { justify-content: center; padding: 0; }
.sb-root[data-collapsed="true"] .sb-settings .sb-label { display: none; }
.sb-toggle { width: 34px; height: 34px; }

.sb-resizer {
  position: absolute;
  top: 0;
  right: 0;
  width: 4px;
  height: 100%;
  cursor: col-resize;
}
.sb-resizer[hidden] { display: none; }
.sb-resizer:hover { background: var(--c-text-3); }

.sb-flyout {
  position: fixed;
  width: 260px;
  overflow-y: auto;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  z-index: var(--z-popover, 20);
  opacity: 0;
  transform: translateX(-2px);
  transition: opacity var(--motion-fast), transform var(--motion-fast);
  pointer-events: none;
}
.sb-flyout[data-open="true"] { opacity: 1; transform: translateX(0); pointer-events: auto; }
.sb-flyout[hidden] { display: none; }

.sb-menu {
  position: fixed;
  min-width: 180px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  z-index: var(--z-popover, 20);
  padding: var(--space-4);
}
.sb-menu[hidden] { display: none; }
.sb-menu button {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  width: 100%;
  height: 30px;
  padding: 0 var(--space-8);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font-size: var(--font-size-md);
  cursor: pointer;
  text-align: left;
}
.sb-menu button:hover { background: var(--c-selection); }
.sb-menu button[data-danger="true"] { color: var(--c-danger); }
.sb-menu button:disabled { opacity: 0.45; cursor: not-allowed; }

.sb-tooltip {
  position: fixed;
  max-width: 240px;
  padding: var(--space-4) var(--space-8);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  color: var(--c-text);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: var(--z-popover, 20);
  pointer-events: none;
}
.sb-tooltip[hidden] { display: none; }

.sb-status {
  padding: 0 var(--space-12) var(--space-4);
  color: var(--c-text-3);
  font-size: var(--font-size-xs);
}
.sb-status[hidden] { display: none; }
`

/** 注入样式表（幂等）。 */
export function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
}
