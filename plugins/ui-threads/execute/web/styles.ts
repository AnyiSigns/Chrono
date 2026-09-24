// 本插件的组件样式（纯字符串，无 DOM、无 react import）：只引用壳提供的 token
// （`/assets/tokens.v1.css`），零硬编码色值。React 组件以 <style> 注入一次。
// 顶栏常显（正常文档流，推挤布局）：标签行 + 待办清单面板；待办复选框为纯 CSS 绘制（accent token 取色）。

export const STYLE_TEXT = `
.threads-root { display: flex; flex-direction: column; }
.threads-root:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.threads-panel { padding: var(--space-12) var(--space-16); background: var(--c-surface);
  border-bottom: 1px solid var(--c-border); }
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
.threads-todo { margin-top: var(--space-8); border: 1px solid var(--c-border);
  border-radius: var(--radius-md); background: var(--c-bg); }
.threads-todo-head { display: flex; align-items: center; gap: var(--space-8); width: 100%;
  min-height: 32px; padding: var(--space-4) var(--space-12); background: none; border: none;
  color: var(--c-text-2); font: inherit; font-size: var(--font-size-xs); text-align: left;
  cursor: pointer; border-radius: inherit; }
.threads-todo-head:hover { background: color-mix(in srgb, var(--c-text) 4%, transparent); }
.threads-todo-head:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.threads-todo-icon { flex: none; color: var(--c-text-3); }
.threads-todo-progress { flex: 1 1 auto; font-variant-numeric: tabular-nums; }
.threads-todo-chevron { flex: none; color: var(--c-text-3); transition: transform var(--motion-fast); }
.threads-todo[data-open="false"] .threads-todo-chevron { transform: rotate(-90deg); }
/* expand / collapse transition: grid row 0fr <-> 1fr + fade; clip carries overflow */
.threads-todo-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--motion-slow); }
.threads-todo[data-open="true"] .threads-todo-body { grid-template-rows: 1fr; }
.threads-todo-clip { overflow: hidden; min-height: 0; }
.threads-todo-list { display: flex; flex-direction: column; gap: var(--space-4);
  padding: 0 var(--space-12) var(--space-8); opacity: 0; transition: opacity var(--motion-slow); }
.threads-todo[data-open="true"] .threads-todo-list { opacity: 1; }
.threads-todo-item { display: flex; align-items: center; gap: var(--space-8); min-height: 28px;
  font-size: var(--font-size-sm); color: var(--c-text); }
.threads-todo-check { flex: none; width: 14px; height: 14px; border: 1px solid var(--c-border);
  border-radius: var(--radius-sm); display: inline-flex; align-items: center; justify-content: center;
  color: var(--c-accent-text); }
.threads-todo-check[data-status="completed"] { background: var(--c-accent); border-color: var(--c-accent); }
.threads-todo-check[data-status="in_progress"] { border-color: var(--c-accent); }
.threads-todo-check[data-status="in_progress"]::after { content: ''; width: 6px; height: 6px;
  border-radius: var(--radius-sm); background: var(--c-accent); }
.threads-todo-item[data-status="completed"] .threads-todo-text { color: var(--c-text-3);
  text-decoration: line-through; }
.threads-todo-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.threads-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.threads-loading { display: inline-flex; align-items: center; gap: var(--space-8); min-height: 24px;
  color: var(--c-text-3); font-size: var(--font-size-sm); }
.threads-empty { display: inline-flex; align-items: center; min-height: 24px; padding: 0 var(--space-8);
  color: var(--c-text-3); font-size: var(--font-size-sm); }
.threads-tag[data-tone="error"] { color: var(--c-danger); }
.threads-tag[data-tone="error"]:hover { background: var(--c-danger-bg); color: var(--c-danger); }
.threads-breathe { width: 32px; height: 2px; border-radius: var(--radius-sm); background: var(--c-text-3);
  animation: threads-breathe 1.6s ease-in-out infinite; }
@keyframes threads-breathe { 0%, 100% { opacity: .25; } 50% { opacity: .6; } }
@media (prefers-reduced-motion: reduce) {
  .threads-dot[data-tone="running"], .threads-breathe { animation: none; }
  .threads-todo-body, .threads-todo-list, .threads-todo-chevron { transition: none; }
}
`
