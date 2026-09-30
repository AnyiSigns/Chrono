// 侧栏样式（React 层随组件渲染的 `<style>`，不再做 DOM 注入）：只用共享 token
// （`/assets/tokens.v1.css`），不硬编码色值；类名统一 `sb-` 前缀。

/** 宽窄切换的时长 + 缓动；槽根（`#slot-sidebar`）的 width 过渡必须与 `.sb-root` 同拍，否则一快一慢会露出裁切。
    `cubic-bezier(0.34, 1.1, 0.64, 1)`：偏利落、快起步，末端仅约 0.2% 回弹（几乎无弹跳感）。 */
export const SIDEBAR_DURATION_MS = 240
const SIDEBAR_EASE = 'cubic-bezier(0.34, 1.1, 0.64, 1)'
export const SIDEBAR_MOTION = `${SIDEBAR_DURATION_MS}ms ${SIDEBAR_EASE}`

export const SIDEBAR_CSS = `
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
  --sb-dur: ${SIDEBAR_DURATION_MS}ms;
  --sb-ease: ${SIDEBAR_EASE};
}
/* Collapse = panel width + whole content pan on the same clock: wide pane slides out, rail slides in, nothing reflows
   (matches the drag feel: pure left/right push). */
.sb-root[data-dragging="true"] { transition: none; }
.sb-root:not([data-dragging="true"]) { transition: width var(--sb-dur) var(--sb-ease); }
.sb-root[data-collapsed="true"] { --sb-width: 56px; }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion="full"]) .sb-root { --sb-dur: 0ms; } }

/* One full-width track: wide pane + rail side by side; collapse shifts it left by one expanded width so the rail lands
   exactly inside the shrink-to-56px viewport. */
.sb-track {
  display: flex;
  align-items: stretch;
  flex: 1 1 auto;
  min-height: 0;
  transition: transform var(--sb-dur) var(--sb-ease);
}
.sb-root[data-dragging="true"] .sb-track { transition: none; }
.sb-root[data-collapsed="true"] .sb-track { transform: translateX(calc(-1 * var(--sb-wide, 260px))); }

.sb-layer { flex: none; display: flex; flex-direction: column; height: 100%; min-width: 0; }
.sb-layer-wide { width: var(--sb-wide, 260px); }
.sb-layer-rail { width: 56px; }

.sb-head {
  padding: var(--space-12) var(--space-12) var(--space-8);
  font-size: var(--font-size-xl);
  font-weight: var(--weight-strong);
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
}
.sb-rail-head {
  padding: var(--space-12) 0 var(--space-8);
  text-align: center;
  font-size: var(--font-size-lg);
  font-weight: var(--weight-strong);
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
}

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
  transition: background-color var(--motion-fast), color var(--motion-fast);
}
.sb-add-rail { justify-content: center; gap: 0; width: 40px; margin: 0 auto var(--space-8); padding: 0; }
.sb-label {
  max-width: 9rem;
  overflow: hidden;
  white-space: nowrap;
}
.sb-add:hover { background: var(--c-selection); color: var(--c-text); }
.sb-add:disabled { opacity: 0.45; cursor: not-allowed; }

.sb-list { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: var(--space-8); }
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
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  height: 34px;
  padding-left: 20px;
  padding-right: var(--space-8);
  border-radius: var(--radius-md);
  color: var(--c-text-2);
  cursor: pointer;
}
.sb-session:hover { background: var(--c-selection); }
.sb-session[data-current="true"] { background: var(--c-selection); color: var(--c-text); font-weight: var(--weight-medium); }
.sb-session[data-current="true"]::before {
  content: '';
  position: absolute;
  left: 0;
  width: 3px;
  height: 18px;
  border-radius: 0 2px 2px 0;
  background: var(--c-accent-strong);
}
.sb-session-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-md); }
/* timestamp flush right; hover actions overlay absolutely (no layout width) to avoid a gap. */
.sb-session-time { flex: none; margin-left: auto; color: var(--c-text-3); font-size: var(--font-size-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.sb-session-actions {
  position: absolute;
  right: var(--space-4);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-left: var(--space-8);
  background: inherit;
  opacity: 0;
}
.sb-session:hover .sb-session-actions, .sb-session:focus-within .sb-session-actions { opacity: 1; }
.sb-session:hover .sb-session-time, .sb-session:focus-within .sb-session-time { visibility: hidden; }
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
/* destructive-action confirm modal (delete / terminate): centered scrim, replaces inline confirm row. */
.sb-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--c-text) 30%, transparent);
  animation: sb-scrim var(--motion-fast) both;
}
.sb-modal {
  width: min(340px, calc(100vw - 32px));
  box-sizing: border-box;
  padding: var(--space-16);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  color: var(--c-text);
  outline: none;
  animation: sb-pop var(--motion-fast) both;
}
.sb-modal-title { font-size: var(--font-size-md); font-weight: var(--weight-strong); }
.sb-modal-subject {
  margin-top: var(--space-4);
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-modal-actions { display: flex; justify-content: flex-end; gap: var(--space-8); margin-top: var(--space-16); }
.sb-modal-btn {
  height: 30px;
  padding: 0 var(--space-12);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
  color: var(--c-text);
  font-size: var(--font-size-md);
  cursor: pointer;
}
.sb-modal-btn:hover { background: var(--c-selection); }
.sb-modal-btn[data-danger="true"] { border-color: var(--c-danger); color: var(--c-danger); background: transparent; }
.sb-modal-btn[data-danger="true"]:hover { background: var(--c-danger-bg); }
.sb-modal-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.sb-modal-btn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
@keyframes sb-scrim { from { opacity: 0; } to { opacity: 1; } }
@keyframes sb-pop { from { opacity: 0; transform: translateY(4px) scale(0.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion="full"]) .sb-modal-backdrop, :root:not([data-motion="full"]) .sb-modal { animation: none; } }

.sb-badge { flex: none; display: inline-flex; align-items: center; gap: var(--space-4); }
.sb-dot { width: 6px; height: 6px; border-radius: 50%; }
.sb-dot[data-kind="running"] { background: var(--c-accent); animation: sb-breathe 1.6s ease-in-out infinite; }
.sb-dot[data-kind="pending"] { background: var(--c-warning); }
.sb-dot[data-kind="failed"] { background: var(--c-danger); }
.sb-dot[data-kind="unread"] { background: var(--c-text-3); }
.sb-dot[data-kind="missing"] { background: var(--c-danger); }
.sb-unread { font-size: var(--font-size-xs); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
@keyframes sb-breathe { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.6; } }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion="full"]) .sb-dot[data-kind="running"] { animation: none; opacity: 0.5; } }

/* Collapsed rail: one folder button opens the flyout on hover; the dot aggregates all workspaces. */
.sb-rail-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin: 0 auto;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--c-text-2);
  font: inherit;
  cursor: pointer;
}
.sb-rail-item:hover,
.sb-rail-item[data-open="true"] { background: var(--c-selection); color: var(--c-text); }
.sb-rail-item:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.sb-rail-dot { position: absolute; top: 6px; right: 6px; }
.sb-rail-static { display: flex; justify-content: center; padding: var(--space-4) 0; }

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
.sb-foot-rail { justify-content: center; padding: var(--space-8) 0; }
.sb-settings {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  flex: 1 1 0%;
  min-width: 0;
  overflow: hidden;
  height: 34px;
  padding: 0 var(--space-8);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--font-size-md);
  cursor: pointer;
  transition: background-color var(--motion-fast), color var(--motion-fast);
}
.sb-settings:hover { background: var(--c-selection); color: var(--c-text); }
.sb-toggle { width: 34px; height: 34px; }
.sb-toggle-glyph { display: inline-flex; animation: sb-toggle-in var(--sb-dur) var(--sb-ease) both; }
@keyframes sb-toggle-in { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: none; } }

.sb-resizer {
  position: absolute;
  top: 0;
  right: 0;
  width: 4px;
  height: 100%;
  cursor: col-resize;
}
.sb-resizer[hidden] { display: none; }
/* Hit area stays 4px, but the visible indicator collapses to 1px: fully transparent by default
   (no longer a full-height grey bar), shown as a faint line only on hover / drag. */
.sb-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 1px;
  height: 100%;
  background: transparent;
  transition: background-color var(--motion-fast);
}
.sb-resizer:hover::after { background: color-mix(in srgb, var(--c-text) 18%, transparent); }
/* Active state while dragging: width already tracks the pointer, so use a muted accent instead of a solid bar. */
.sb-root[data-dragging="true"] .sb-resizer::after { background: var(--c-accent-strong); }

.sb-flyout {
  position: fixed;
  width: 260px;
  overflow-y: auto;
  scrollbar-width: none;
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
.sb-flyout::-webkit-scrollbar { width: 0; height: 0; }
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

/* Unify hover / focus feedback on a short transition: these used to switch instantly, which felt harsh.
   Only color / opacity (no layout); with reduced motion --motion-fast is zero so it turns off. */
.sb-group-head, .sb-session, .sb-iconbtn, .sb-rail-item, .sb-modal-btn, .sb-menu button {
  transition: background-color var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast);
}
.sb-group-actions, .sb-session-actions { transition: opacity var(--motion-fast); }
`
