// 本插件的组件样式：只引用壳提供的 token（`/assets/tokens.v1.css`），零硬编码色值；
// 需要半透明处用 `color-mix(... var(--c-*) ...)` 由 token 派生，不写死 rgba / hex。
// .chat-list 的 border-box + min-height:100%：内容不足一屏时撑满滚动口（空态靠 flex:1 垂直居中），
// 内容超长自然增长；缺 border-box 时 padding 会把 100% 顶出滚动条。
// 样式由 `entry.tsx` 的 App 以 `<style>` 随组件树注入（不再由 mount 期 `ensureStyles` 注入）。

export const STYLE_TEXT = `
.chat-root { position: relative; height: 100%; min-height: var(--main-min-h); display: flex; flex-direction: column; }
.chat-status { flex: none; height: 2px; display: flex; justify-content: center; }
.chat-status[hidden] { display: none; }
.chat-status .chat-breathe { width: 100%; height: 2px; }
.chat-scroll { flex: 1 1 auto; overflow: auto; }
.chat-list { box-sizing: border-box; min-height: 100%; max-width: var(--msg-max-w); margin: 0 auto; padding: var(--space-16); display: flex; flex-direction: column; gap: var(--msg-gap); transition: opacity var(--motion-base); }
.chat-msg { display: flex; flex-direction: column; gap: var(--space-4); }
.chat-msg-user { align-items: flex-end; }
.chat-bubble-user { max-width: var(--bubble-max-w); background: var(--c-selection); border-radius: var(--radius-lg); padding: var(--space-8) var(--space-12); white-space: pre-wrap; word-break: break-word; }
.chat-msg-assistant { align-items: stretch; }
.chat-msg-assistant-body { display: flex; flex-direction: column; gap: var(--space-8); }
.chat-muted { color: var(--c-text-2); }
.chat-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.chat-block-loading { display: flex; flex-direction: column; align-items: center; gap: var(--space-8); padding: var(--space-24); }
.chat-top-notice { display: flex; justify-content: center; }
.chat-question-group { display: flex; flex-direction: column; gap: var(--space-4); }
.chat-md { font-size: var(--font-size-md); line-height: var(--leading-body); word-break: break-word; }
.chat-md p { margin: 0 0 var(--space-8); }
.chat-md p:last-child { margin-bottom: 0; }
.chat-md h1, .chat-md h2, .chat-md h3, .chat-md h4, .chat-md h5, .chat-md h6 { margin: var(--space-12) 0 var(--space-8); font-weight: var(--weight-strong); line-height: var(--leading-body); }
.chat-md h1 { font-size: var(--font-size-xl); }
.chat-md h2 { font-size: var(--font-size-lg); }
.chat-md h3, .chat-md h4, .chat-md h5, .chat-md h6 { font-size: var(--font-size-md); }
.chat-md pre { background: var(--c-bg); border-radius: var(--radius-md); padding: var(--space-8) var(--space-12); overflow-x: auto; font-family: var(--font-mono); font-size: var(--font-size-sm); line-height: var(--leading-code); margin: 0 0 var(--space-8); }
.chat-md code { font-family: var(--font-mono); font-size: var(--font-size-sm); }
.chat-md p > code, .chat-md li > code, .chat-md td > code { background: var(--c-bg); border-radius: var(--radius-sm); padding: 0 var(--space-4); }
.chat-md a { color: var(--c-accent); }
.chat-md img { max-width: 100%; height: auto; border-radius: var(--radius-md); cursor: zoom-in; }
.chat-md blockquote { border-left: 3px solid var(--c-border); margin: 0 0 var(--space-8); padding-left: var(--space-12); color: var(--c-text-2); }
.chat-md ul, .chat-md ol { margin: 0 0 var(--space-8); padding-left: var(--space-24); }
.chat-md hr { border: none; border-top: 1px solid var(--c-border); }
.chat-system { background: var(--c-surface); border-left: 3px solid var(--c-danger); border-radius: var(--radius-md); padding: var(--space-8) var(--space-12); color: var(--c-text-2); font-size: var(--font-size-sm); }
.chat-footnote { display: flex; align-items: center; gap: var(--space-8); min-height: 24px; font-size: var(--font-size-xs); color: var(--c-text-3); opacity: 0; transition: opacity var(--motion-fast); }
.chat-msg:hover .chat-footnote, .chat-footnote:focus-within { opacity: 1; }
.chat-usage { font-variant-numeric: tabular-nums; }
.chat-iconbtn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0; background: none; border: none; border-radius: var(--radius-sm); color: var(--c-text-3); cursor: pointer; }
.chat-iconbtn:hover { color: var(--c-text); background: var(--c-selection); }
.chat-iconbtn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-iconbtn[data-copy="check"] { color: var(--c-success); }
.chat-iconbtn[data-copy="error"] { color: var(--c-danger); }
.chat-iconbtn[data-copy="check"] svg, .chat-iconbtn[data-copy="error"] svg, .chat-iconbtn[data-copy="idle"] svg { animation: chat-fade var(--motion-fast) both; }
.chat-danger-inline { display: inline-flex; align-items: center; gap: var(--space-4); color: var(--c-danger); font-size: var(--font-size-xs); }
.chat-warning-inline { display: inline-flex; align-items: center; gap: var(--space-4); color: var(--c-warning); font-size: var(--font-size-xs); }
.chat-media-img { display: block; max-width: 320px; max-height: 240px; border-radius: var(--radius-md); cursor: zoom-in; }
.chat-media-frame { display: inline-block; }
.chat-media-frame .chat-media-img { width: 100%; height: 100%; max-width: none; max-height: none; object-fit: contain; }
.chat-media-video { display: block; max-width: 320px; max-height: 180px; border-radius: var(--radius-md); background: var(--c-bg); }
.chat-video-thumb { position: relative; display: inline-block; }
.chat-video-play { position: absolute; left: var(--space-8); bottom: var(--space-8); min-height: 24px; padding: var(--space-4) var(--space-8); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-sm); color: var(--c-text); font: inherit; font-size: var(--font-size-xs); cursor: pointer; }
.chat-video-play:hover { background: var(--c-selection); }
.chat-video-play:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-media-audio { width: 100%; max-width: 480px; height: 40px; }
.chat-file { display: flex; align-items: center; gap: var(--space-8); height: 34px; max-width: 320px; padding: 0 var(--space-8); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); font-size: var(--font-size-sm); }
.chat-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-placeholder { display: flex; align-items: center; gap: var(--space-8); max-width: 320px; padding: var(--space-8) var(--space-12); background: var(--c-bg); border-radius: var(--radius-md); color: var(--c-text-2); font-size: var(--font-size-sm); }
.chat-tool { font-size: var(--font-size-sm); }
.chat-tool-card { border-radius: var(--radius-md); }
.chat-tool-ghost { background: transparent; border: 1px solid transparent; }
.chat-tool-plain { background: var(--c-surface); border: 1px solid var(--c-border); }
.chat-tool-solid { background: var(--c-surface); border: 1px solid var(--c-border); border-left: 3px solid var(--c-warning); }
.chat-tool-line { display: flex; align-items: center; gap: var(--space-8); min-height: 24px; padding: var(--space-4) var(--space-8); color: var(--c-text-2); }
.chat-tool-line[data-tone="solid"] { border-left: 3px solid var(--c-warning); }
.chat-tool-icon { flex: none; color: var(--c-text-3); }
.chat-tool-head { display: flex; align-items: center; gap: var(--space-8); width: 100%; min-height: 28px; padding: var(--space-4) var(--space-8); background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: inherit; }
.chat-tool-head:hover { background: color-mix(in srgb, var(--c-text) 4%, transparent); }
.chat-tool-head:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-tool-label { flex: none; font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--c-text-2); }
.chat-tool-summary { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-2); }
.chat-tool-status { flex: none; display: inline-flex; align-items: center; color: var(--c-text-3); }
.chat-tool-status[data-state="ok"] { color: var(--c-success); }
.chat-tool-status[data-state="error"] { color: var(--c-danger); }
.chat-tool-spin { width: 8px; height: 8px; border-radius: 50%; background: var(--c-accent); animation: chat-breathe 1.2s ease-in-out infinite; }
.chat-tool-chevron { flex: none; color: var(--c-text-3); transition: transform var(--motion-fast); }
.chat-tool[data-open="true"] .chat-tool-chevron { transform: rotate(90deg); }
.chat-tool-detail { padding: var(--space-8); border-top: 1px solid var(--c-border); }
.chat-reasoning { border-radius: var(--radius-md); }
.chat-reasoning-head { display: flex; align-items: center; gap: var(--space-8); width: 100%; min-height: 24px; padding: var(--space-4) var(--space-8); background: none; border: none; color: var(--c-text-3); font: inherit; font-size: var(--font-size-sm); text-align: left; cursor: pointer; border-radius: inherit; }
.chat-reasoning-head:hover { background: color-mix(in srgb, var(--c-text) 4%, transparent); }
.chat-reasoning-head:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-reasoning-icon { flex: none; }
.chat-reasoning-label { flex: 1 1 auto; }
.chat-reasoning-chevron { flex: none; transition: transform var(--motion-fast); }
.chat-reasoning[data-open="true"] .chat-reasoning-chevron { transform: rotate(90deg); }
.chat-reasoning-body { margin-top: var(--space-4); padding: var(--space-8) var(--space-12); background: var(--c-bg); border-radius: var(--radius-md); color: var(--c-text-2); font-size: var(--font-size-sm); font-style: italic; }
.chat-reasoning-body .chat-md { font-size: var(--font-size-sm); color: var(--c-text-2); }
.chat-code-block { margin: 0; padding: var(--space-8) var(--space-12); background: var(--c-bg); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--font-size-sm); line-height: var(--leading-code); overflow-x: auto; white-space: pre; }
.chat-diff { padding: var(--space-4) 0; background: var(--c-bg); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--font-size-sm); line-height: var(--leading-code); overflow-x: auto; }
.chat-diff-row { display: flex; gap: var(--space-8); padding: 0 var(--space-8); white-space: pre; }
.chat-diff-add { background: var(--c-success-bg); color: var(--c-success); }
.chat-diff-del { background: var(--c-danger-bg); color: var(--c-danger); }
.chat-diff-mod { background: var(--c-warning-bg); color: var(--c-warning); }
.chat-diff-ctx { color: var(--c-text-2); }
.chat-diff-hunk { color: var(--c-text-3); }
.chat-terminal { padding: var(--space-8); background: var(--c-bg); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--font-size-sm); line-height: var(--leading-code); max-height: 240px; overflow: auto; white-space: pre-wrap; }
.chat-terminal-stderr { color: var(--c-danger); }
.chat-terminal-exit { color: var(--c-text-3); }
.chat-matches, .chat-paths, .chat-list-detail { font-family: var(--font-mono); font-size: var(--font-size-sm); display: flex; flex-direction: column; gap: var(--space-4); }
.chat-matches-line { color: var(--c-text-3); }
.chat-table { border-collapse: collapse; font-size: var(--font-size-sm); }
.chat-table th, .chat-table td { border: 1px solid var(--c-border); padding: var(--space-4) var(--space-8); text-align: left; }
.chat-question { display: flex; flex-direction: column; gap: var(--space-8); }
.chat-question[data-expired="true"] { color: var(--c-text-3); }
.chat-question-q { font-weight: var(--weight-strong); }
.chat-question-opt { display: flex; align-items: flex-start; gap: var(--space-8); min-height: 24px; padding: var(--space-4); border-radius: var(--radius-sm); cursor: pointer; }
.chat-question-opt:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-question-opt[aria-checked="true"] { background: var(--c-selection); }
.chat-question-opt-desc { color: var(--c-text-2); font-size: var(--font-size-xs); }
.chat-question-input { width: 100%; padding: var(--space-4) var(--space-8); background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-sm); color: var(--c-text); font: inherit; }
.chat-question-input:focus-visible { outline: none; border-color: var(--c-text-3); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-accent) 8%, transparent); }
.chat-question-actions { display: flex; align-items: center; gap: var(--space-8); }
.chat-btn { min-height: 24px; padding: var(--space-4) var(--space-12); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-sm); color: var(--c-text); font: inherit; font-size: var(--font-size-sm); cursor: pointer; }
.chat-btn:hover { background: var(--c-selection); }
.chat-btn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-btn-accent { background: var(--c-accent); border-color: var(--c-accent); color: var(--c-accent-text); }
.chat-btn:disabled { opacity: .45; cursor: not-allowed; }
.chat-breathe { width: 48px; height: 2px; border-radius: var(--radius-sm); background: var(--c-text-3); animation: chat-breathe 1.6s ease-in-out infinite; }
.chat-breathe-inline { width: 32px; }
/* 「正在工作」银色流光：中灰底 + 浅银高光带自左向右扫过（流光）+ 透明度脉冲（呼吸感）；
   纯灰阶、不引入强调色。字号与消息正文一致（.chat-md）。流式回合全程常驻，右侧带秒级计时。 */
.chat-working { --working-base: var(--c-text-2);
  --working-hi: color-mix(in srgb, var(--c-text-2) 40%, var(--c-bg));
  display: flex; align-items: baseline; gap: var(--space-4); width: fit-content;
  font-size: var(--font-size-md); line-height: var(--leading-body);
  background: linear-gradient(90deg,
    var(--working-base) 0%, var(--working-base) 34%,
    var(--working-hi) 50%,
    var(--working-base) 66%, var(--working-base) 100%);
  background-size: 200% 100%; background-repeat: no-repeat;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: chat-shimmer 2.4s linear infinite, chat-working-pulse 2.6s ease-in-out infinite; }
.chat-working-time { font-variant-numeric: tabular-nums; }
/* 省略号：三个点依次明灭（点用自身灰色，不参与父层渐变裁切，保证可见）。 */
.chat-working-dots { display: inline-flex; margin-left: 1px; color: var(--c-text-3); }
.chat-working-dots > span { animation: chat-dot 1.4s ease-in-out infinite; }
.chat-working-dots > span:nth-child(2) { animation-delay: .2s; }
.chat-working-dots > span:nth-child(3) { animation-delay: .4s; }
.chat-cursor { display: inline-block; width: 1px; height: 1em; margin-left: 1px; background: var(--c-text); vertical-align: text-bottom; animation: chat-breathe 1.6s ease-in-out infinite; }
.chat-pill { position: absolute; left: 50%; bottom: var(--space-16); transform: translateX(-50%); padding: var(--space-4) var(--space-12); background: var(--c-accent); color: var(--c-accent-text); border: none; border-radius: 999px; font: inherit; font-size: var(--font-size-xs); font-variant-numeric: tabular-nums; cursor: pointer; z-index: var(--z-popover); }
.chat-pill:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-12); padding: var(--space-24); text-align: center; }
.chat-empty-logo { width: 40px; height: 40px; border-radius: var(--radius-xl); box-shadow: var(--shadow-soft); }
.chat-empty-title { font-size: var(--font-size-lg); font-weight: var(--weight-medium); color: var(--c-text); }
.chat-empty-hint { font-size: var(--font-size-sm); color: var(--c-text-3); }
.chat-error { display: flex; align-items: center; gap: var(--space-8); padding: var(--space-8) var(--space-12); background: var(--c-surface); border-left: 3px solid var(--c-danger); border-radius: var(--radius-md); color: var(--c-text-2); font-size: var(--font-size-sm); }
.chat-error-title { color: var(--c-text); }
.chat-subagent-head { font-size: var(--font-size-xs); color: var(--c-text-2); }
.chat-group-item { display: flex; gap: var(--space-8); }
.chat-group-avatar { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--c-selection); display: flex; align-items: center; justify-content: center; font-size: var(--font-size-xs); color: var(--c-text); }
.chat-group-avatar[data-current="true"] { box-shadow: 0 0 0 1.5px var(--c-accent); animation: chat-breathe 1.6s ease-in-out infinite; }
.chat-group-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--space-4); }
.chat-group-name { font-size: var(--font-size-xs); color: var(--c-text-2); }
.chat-group-bubble { padding: var(--space-8) var(--space-12); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); }
.chat-anchor { padding-top: var(--space-4); border-top: 1px solid var(--c-accent); color: var(--c-accent); font-size: var(--font-size-xs); text-align: center; transition: opacity var(--motion-base); }
.chat-workflow { display: flex; flex-direction: column; gap: var(--space-8); padding: var(--space-12); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); }
.chat-workflow-title { font-size: var(--font-size-md); font-weight: var(--weight-strong); }
.chat-workflow-meta { font-size: var(--font-size-xs); color: var(--c-text-2); }
.chat-workflow-track { height: 1px; background: var(--c-border); }
.chat-workflow-fill { height: 1px; background: var(--c-accent); }
.chat-workflow-node { display: flex; align-items: center; gap: var(--space-8); font-size: var(--font-size-sm); }
.chat-workflow-node[data-status="failed"] { color: var(--c-danger); }
.chat-workflow-node[data-status="success"] { color: var(--c-success); }
.chat-workflow-node[data-status="skipped"] { color: var(--c-text-3); }
.chat-date { margin: var(--space-12) 0; text-align: center; font-size: var(--font-size-xs); color: var(--c-text-3); }
.chat-lightbox { position: fixed; inset: 0; z-index: var(--z-lightbox); display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--c-text) 28%, transparent); animation: chat-fade var(--motion-base) both; }
.chat-lightbox-img { max-width: 90vw; max-height: 86vh; box-shadow: var(--shadow-pop); cursor: grab; }
.chat-lightbox-img[data-dragging="true"] { cursor: grabbing; }
.chat-lightbox-close { position: absolute; top: var(--space-16); right: var(--space-16); color: var(--c-text); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-sm); }
@keyframes chat-breathe { 0%, 100% { opacity: .25; } 50% { opacity: .6; } }
@keyframes chat-shimmer { from { background-position: 100% 0; } to { background-position: 0% 0; } }
@keyframes chat-working-pulse { 0%, 100% { opacity: .8; } 50% { opacity: 1; } }
@keyframes chat-dot { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
@keyframes chat-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  /* 呼吸条 / 光标 / 旋转为位移动效，减少动态时停用；「正在工作」仅色彩与透明度变化，保留以维持可辨识度。 */
  .chat-breathe, .chat-cursor, .chat-tool-spin, .chat-group-avatar[data-current="true"] { animation: none; }
  .chat-breathe, .chat-cursor, .chat-tool-spin, .chat-group-avatar[data-current="true"] { opacity: .4; }
  .chat-lightbox { animation: none; }
  .chat-list, .chat-footnote, .chat-tool-chevron, .chat-reasoning-chevron, .chat-anchor { transition: none; }
}
`
