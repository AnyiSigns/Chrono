// 本插件的组件样式（纯字符串，无 DOM、无 react import）：只引用壳提供的 token
// （`/assets/tokens.v1.css`），零硬编码色值。React 组件以 <style> 注入一次。
// 顶栏常态 0 高度（overlay，不推挤布局）：热区 8px 条带，hover 展开面板浮在 main 之上。

export const STYLE_TEXT = `
.threads-root { position: absolute; top: 0; left: 0; right: 0; z-index: var(--z-topbar); }
.threads-root:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.threads-hit { height: 8px; }
.threads-panel { position: absolute; top: 0; left: 0; right: 0; padding: var(--space-8) var(--space-12) var(--space-8);
  background: var(--c-surface); border-bottom: 1px solid var(--c-border); box-shadow: var(--shadow-pop);
  opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-base); }
.threads-root[data-open="true"] .threads-panel { opacity: 1; visibility: visible; pointer-events: auto; }
.threads-tags { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.threads-tag { position: relative; display: inline-flex; align-items: center; gap: var(--space-4);
  min-height: 24px; padding: 0 var(--space-8); background: none; border: 1px solid transparent;
  border-radius: var(--radius-md); color: var(--c-text-2); font: inherit; font-size: var(--font-size-sm);
  cursor: pointer; }
.threads-tag:hover { background: var(--c-selection); color: var(--c-text); }
.threads-tag:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.threads-tag[data-active="true"] { background: var(--c-selection); color: var(--c-text); }
.threads-tag[data-kind="main"] { font-weight: var(--weight-strong); }
.threads-label { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.threads-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-text-3); flex: none; }
.threads-dot[data-tone="running"] { background: var(--c-info); animation: threads-breathe 1.6s ease-in-out infinite; }
.threads-dot[data-tone="pending"] { background: var(--c-warning); }
.threads-dot[data-tone="done"] { background: var(--c-success); }
.threads-dot[data-tone="failed"] { background: var(--c-danger); }
.threads-unread { min-width: 16px; height: 16px; padding: 0 var(--space-4); border-radius: var(--radius-sm);
  background: var(--c-selection); color: var(--c-text-2); font-size: var(--font-size-xs);
  line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.threads-todo { margin-top: var(--space-8); border-top: 1px solid var(--c-border); padding-top: var(--space-8); }
.threads-todo-heading { font-size: var(--font-size-xs); color: var(--c-text-2); margin-bottom: var(--space-4); }
.threads-todo-item { display: flex; align-items: baseline; gap: var(--space-8); min-height: 24px;
  font-size: var(--font-size-sm); color: var(--c-text); }
.threads-todo-status { flex: none; font-size: var(--font-size-xs); color: var(--c-text-3); }
.threads-todo-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.threads-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.threads-breathe { width: 32px; height: 2px; border-radius: var(--radius-sm); background: var(--c-text-3);
  animation: threads-breathe 1.6s ease-in-out infinite; }
@keyframes threads-breathe { 0%, 100% { opacity: .25; } 50% { opacity: .6; } }
@media (prefers-reduced-motion: reduce) {
  .threads-dot[data-tone="running"], .threads-breathe { animation: none; }
}
`
