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
/* 关掉浏览器滚动锚定：贴底靠每帧写 scrollTop（pinToBottom）实现，若锚定也改写滚动位，
   两者互抢会出现细微抖动（流式时最明显）。 */
.chat-scroll { flex: 1 1 auto; overflow: auto; overflow-anchor: none; }
.chat-list { box-sizing: border-box; min-height: 100%; max-width: var(--msg-max-w); margin: 0 auto; padding: var(--space-16); display: flex; flex-direction: column; gap: var(--msg-gap); transition: opacity var(--motion-base); }
/* contain: layout：每条消息的布局自成一块——流式消息每帧长高不牵动同窗其它消息的布局。
   不用 content-visibility / contain: paint：前者与窗口化滚动高度估算打架，后者会裁掉表格导出菜单。 */
.chat-msg { display: flex; flex-direction: column; gap: var(--space-4); contain: layout; }
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
/* 分片注入（.chat-md-part = 冻结前缀片 + 尾部片）：非末片是「消息中途」，段末留白必须保留，
   否则前缀片与尾片之间会丢一个段间距（且随跨边界移动造成抖动）。末片仍按消息末尾处理。 */
.chat-md .chat-md-part:not(:last-child) > p:last-child { margin-bottom: var(--space-8); }
.chat-md h1, .chat-md h2, .chat-md h3, .chat-md h4, .chat-md h5, .chat-md h6 { margin: var(--space-12) 0 var(--space-8); font-weight: var(--weight-strong); line-height: var(--leading-body); }
.chat-md h1 { font-size: var(--font-size-xl); }
.chat-md h2 { font-size: var(--font-size-lg); }
.chat-md h3, .chat-md h4, .chat-md h5, .chat-md h6 { font-size: var(--font-size-md); }
.chat-md pre { background: transparent; border-radius: 0; padding: var(--space-8) var(--space-12); overflow-x: auto; font-family: var(--font-mono); font-size: var(--font-size-sm); line-height: var(--leading-code); margin: 0; }
.chat-md code { font-family: var(--font-mono); font-size: var(--font-size-sm); }
/* 代码块外壳：头（语言标签 + 展开 / 复制按钮）+ pre。整块同一气泡面，
   头与代码之间不再画分隔线，仅靠同一底色与留白区分。 */
.chat-codeblock { margin: 0 0 var(--space-8); background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-md); overflow: hidden; }
.chat-codeblock-head { display: flex; align-items: center; justify-content: space-between; height: 28px; padding: 0 var(--space-8); }
.chat-codeblock-lang { font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--c-text-3); }
.chat-codeblock-actions { display: inline-flex; align-items: center; gap: var(--space-4); }
/* 折叠：pre 限高（约 16 行）成可滚代码框，滚轮在框内滚动；展开后不限高、显示全部代码。 */
.chat-codeblock[data-collapsed="true"] pre { max-height: calc(var(--leading-code) * 16 + var(--space-16)); overflow-y: auto; overscroll-behavior: contain; }
/* 展开 / 收起按钮：图标走 CSS mask（无内联 svg），按 aria-expanded 翻向下 / 向上箭头。 */
.chat-codeblock-toggle { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 20px; padding: 0; background: none; border: none; color: var(--c-text-3); cursor: pointer; border-radius: var(--radius-sm); }
.chat-codeblock-toggle:hover { color: var(--c-text); background: var(--c-selection); }
.chat-codeblock-toggle:focus-visible { outline: 2px solid var(--c-accent-strong); outline-offset: 2px; }
.chat-codeblock-toggle::before { content: ''; display: block; width: 14px; height: 14px; background: currentColor; -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>") center / contain no-repeat; mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>") center / contain no-repeat; }
.chat-codeblock-toggle[aria-expanded="true"]::before { -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 15l6-6 6 6'/></svg>") center / contain no-repeat; mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 15l6-6 6 6'/></svg>") center / contain no-repeat; }
.chat-codeblock-copy { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 20px; padding: 0; background: none; border: none; color: var(--c-text-3); cursor: pointer; border-radius: var(--radius-sm); }
.chat-codeblock-copy:hover { color: var(--c-text); background: var(--c-selection); }
.chat-codeblock-copy:focus-visible { outline: 2px solid var(--c-accent-strong); outline-offset: 2px; }
/* 复制 / 勾 / 错 图标走 CSS mask（无内联 svg，sanitize 不放行 svg），currentColor 着色。
   代码块与表格的复制按钮共用同一套图标与状态。 */
.chat-codeblock-copy::before, .chat-table-copy::before { content: ''; display: block; width: 14px; height: 14px; background: currentColor; -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='11' height='11' rx='2'/><path d='M5 15V5a2 2 0 0 1 2-2h10'/></svg>") center / contain no-repeat; mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='11' height='11' rx='2'/><path d='M5 15V5a2 2 0 0 1 2-2h10'/></svg>") center / contain no-repeat; }
.chat-codeblock-copy[data-copy="check"], .chat-table-copy[data-copy="check"] { color: var(--c-success); }
.chat-codeblock-copy[data-copy="check"]::before, .chat-table-copy[data-copy="check"]::before { -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12l5 5 9-11'/></svg>") center / contain no-repeat; mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12l5 5 9-11'/></svg>") center / contain no-repeat; }
.chat-codeblock-copy[data-copy="error"], .chat-table-copy[data-copy="error"] { color: var(--c-danger); }
.chat-codeblock-copy[data-copy="error"]::before, .chat-table-copy[data-copy="error"]::before { -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 8v5'/><path d='M12 16h.01'/></svg>") center / contain no-repeat; mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 8v5'/><path d='M12 16h.01'/></svg>") center / contain no-repeat; }
/* 表格导出按钮：下载图标。 */
.chat-table-export::before { content: ''; display: block; width: 14px; height: 14px; background: currentColor; -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3v12'/><path d='M7 11l5 5 5-5'/><path d='M4 20h16'/></svg>") center / contain no-repeat; mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3v12'/><path d='M7 11l5 5 5-5'/><path d='M4 20h16'/></svg>") center / contain no-repeat; }
/* highlight.js token 着色：中饱和、高对比，由 tokens 的 --c-code-* 提供配色。 */
.chat-md .hljs-comment, .chat-md .hljs-quote { color: var(--c-code-meta); font-style: italic; }
.chat-md .hljs-keyword, .chat-md .hljs-selector-tag, .chat-md .hljs-doctag, .chat-md .hljs-name, .chat-md .hljs-section { color: var(--c-code-kw); }
.chat-md .hljs-tag { color: var(--c-code-tag); }
.chat-md .hljs-string { color: var(--c-code-str); }
.chat-md .hljs-regexp { color: var(--c-code-regexp); }
.chat-md .hljs-number, .chat-md .hljs-literal, .chat-md .hljs-bullet { color: var(--c-code-num); }
.chat-md .hljs-title, .chat-md .hljs-title.function_, .chat-md .hljs-built_in { color: var(--c-code-fn); }
.chat-md .hljs-function .hljs-title { color: var(--c-code-fn); }
.chat-md .hljs-title.class_, .chat-md .hljs-type { color: var(--c-code-type); }
.chat-md .hljs-class .hljs-title { color: var(--c-code-type); }
.chat-md .hljs-attr, .chat-md .hljs-attribute, .chat-md .hljs-property { color: var(--c-code-attr); }
.chat-md .hljs-variable, .chat-md .hljs-template-variable { color: var(--c-code-attr); }
.chat-md .hljs-symbol, .chat-md .hljs-link { color: var(--c-code-fn); }
.chat-md .hljs-meta { color: var(--c-code-meta); }
.chat-md .hljs-meta .hljs-string { color: var(--c-code-str); }
.chat-md .hljs-deletion { color: var(--c-danger); }
.chat-md .hljs-addition { color: var(--c-success); }
.chat-md .hljs-emphasis { font-style: italic; }
.chat-md .hljs-strong { font-weight: var(--weight-strong); }
.chat-md p > code, .chat-md li > code, .chat-md td > code { background: var(--c-bg); border-radius: var(--radius-sm); padding: 0 var(--space-4); }
/* 表格：外层可横向滚动，单元格复用 .chat-table 的边框 / 内边距，data-align 控制对齐。 */
.chat-tableblock { position: relative; margin: 0 0 var(--space-8); }
.chat-md .chat-table-wrap { overflow-x: auto; }
.chat-md .chat-table { width: 100%; }
.chat-md .chat-table th[data-align="center"], .chat-md .chat-table td[data-align="center"] { text-align: center; }
.chat-md .chat-table th[data-align="right"], .chat-md .chat-table td[data-align="right"] { text-align: right; }
/* 表格右上角悬浮工具条：悬停 / 聚焦才显现，不占内容高度；浮在表格上故给底色与描边。 */
.chat-table-head { position: absolute; top: var(--space-4); right: var(--space-4); z-index: 1; display: inline-flex; align-items: center; gap: var(--space-4); opacity: 0; transition: opacity var(--motion-fast); }
.chat-tableblock:hover .chat-table-head, .chat-table-head:focus-within, .chat-tableblock.chat-menu-open .chat-table-head { opacity: 1; }
.chat-table-copy, .chat-table-export { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 20px; padding: 0; background: var(--c-surface); border: 1px solid var(--c-border); color: var(--c-text-3); cursor: pointer; border-radius: var(--radius-sm); }
.chat-table-copy:hover, .chat-table-export:hover { color: var(--c-text); background: var(--c-selection); }
.chat-table-copy:focus-visible, .chat-table-export:focus-visible { outline: 2px solid var(--c-accent-strong); outline-offset: 2px; }
.chat-table-export[aria-expanded="true"] { color: var(--c-text); background: var(--c-selection); }
.chat-table-copy[data-copy="check"] { color: var(--c-success); }
.chat-table-copy[data-copy="error"] { color: var(--c-danger); }
/* 导出格式菜单：展开时浮在工具条下方。 */
.chat-table-menu { position: absolute; top: calc(var(--space-4) + 22px); right: var(--space-4); z-index: var(--z-popover); display: none; flex-direction: column; min-width: 96px; padding: var(--space-4); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-md); box-shadow: var(--shadow-pop); animation: chat-pop-in var(--motion-fast) both; }
.chat-tableblock.chat-menu-open .chat-table-menu { display: flex; }
.chat-table-menu button { display: block; width: 100%; padding: var(--space-4) var(--space-8); background: none; border: none; border-radius: var(--radius-sm); color: var(--c-text); font: inherit; font-size: var(--font-size-sm); text-align: left; cursor: pointer; }
.chat-table-menu button:hover { background: var(--c-selection); }
.chat-table-menu button:focus-visible { outline: 2px solid var(--c-accent-strong); outline-offset: -2px; }
.chat-md a { color: var(--c-accent-strong); }
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
.chat-tool-detail { padding: var(--space-8); border-top: 1px solid var(--c-border); animation: chat-pop-in var(--motion-base) both; }
.chat-reasoning { border-radius: var(--radius-md); }
.chat-reasoning-head { display: flex; align-items: center; gap: var(--space-8); width: 100%; min-height: 24px; padding: var(--space-4) var(--space-8); background: none; border: none; color: var(--c-text-3); font: inherit; font-size: var(--font-size-sm); text-align: left; cursor: pointer; border-radius: inherit; }
.chat-reasoning-head:hover { background: color-mix(in srgb, var(--c-text) 4%, transparent); }
.chat-reasoning-head:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-reasoning-icon { flex: none; }
.chat-reasoning-label { flex: 1 1 auto; }
.chat-reasoning-chevron { flex: none; transition: transform var(--motion-fast); }
.chat-reasoning[data-open="true"] .chat-reasoning-chevron { transform: rotate(90deg); }
.chat-reasoning-body { margin-top: var(--space-4); padding: var(--space-8) var(--space-12); background: color-mix(in srgb, var(--c-text) 2%, transparent); border-radius: var(--radius-md); color: var(--c-text-2); font-size: var(--font-size-sm); font-style: italic; animation: chat-pop-in var(--motion-base) both; }
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
.chat-match { display: flex; flex-direction: column; }
.chat-match-head { display: flex; gap: var(--space-8); align-items: baseline; }
.chat-match-count { color: var(--c-text-3); }
.chat-match-context { color: var(--c-text-3); white-space: pre-wrap; }
.chat-match-hit { white-space: pre-wrap; }
.chat-table { border-collapse: collapse; font-size: var(--font-size-sm); }
.chat-table th, .chat-table td { border: 1px solid var(--c-border); padding: var(--space-4) var(--space-8); text-align: left; }
.chat-question { display: flex; flex-direction: column; gap: var(--space-12); }
.chat-question[data-expired="true"] { opacity: .72; }
.chat-question-head { display: flex; align-items: center; gap: var(--space-8); }
.chat-question-icon { flex: none; display: inline-flex; color: var(--c-accent-strong); }
.chat-question-heading { flex: 1 1 auto; min-width: 0; font-size: var(--font-size-md); font-weight: var(--weight-strong); line-height: var(--leading-body); }
.chat-question-badge { flex: none; padding: 0 var(--space-8); border: 1px solid var(--c-border); border-radius: 999px; color: var(--c-text-3); font-size: var(--font-size-xs); line-height: 18px; }
.chat-question-text { color: var(--c-text-2); line-height: var(--leading-body); }
.chat-question-nav { display: flex; align-items: center; justify-content: space-between; gap: var(--space-8); }
.chat-question-progress { display: inline-flex; align-items: center; gap: var(--space-8); color: var(--c-text-3); font-size: var(--font-size-xs); }
.chat-question-dots { display: inline-flex; gap: var(--space-4); }
.chat-question-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-border); }
.chat-question-dot[data-state="done"] { background: var(--c-text-3); }
.chat-question-dot[data-state="current"] { background: var(--c-accent); }
.chat-question-nav-btns { display: flex; gap: var(--space-4); }
.chat-question-nav-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; background: transparent; border: 1px solid var(--c-border); border-radius: var(--radius-sm); color: var(--c-text-2); font: inherit; cursor: pointer; }
.chat-question-nav-btn:hover:not(:disabled) { background: var(--c-selection); }
.chat-question-nav-btn:disabled { opacity: .4; cursor: not-allowed; }
.chat-question-nav-btn:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-question-q { font-weight: var(--weight-strong); line-height: var(--leading-body); }
.chat-question-opts { display: flex; flex-direction: column; gap: var(--space-4); }
.chat-question-opt { display: flex; align-items: flex-start; gap: var(--space-8); width: 100%; padding: var(--space-8) var(--space-12); background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-md); color: var(--c-text); font: inherit; text-align: left; cursor: pointer; transition: border-color var(--motion-fast), background var(--motion-fast); }
.chat-question-opt[data-readonly="true"] { cursor: default; }
.chat-question-opt:hover:not(:disabled):not([data-readonly="true"]) { border-color: var(--c-text-3); }
.chat-question-opt[aria-checked="true"] { border-color: var(--c-accent-strong); background: var(--c-info-bg); }
.chat-question-opt:focus-visible { outline: 2px solid var(--c-text); outline-offset: 2px; }
.chat-question-opt:disabled { cursor: not-allowed; }
.chat-question-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-top: 3px; border: 1.5px solid var(--c-text-3); background: var(--c-bg); color: transparent; transition: border-color var(--motion-fast), background var(--motion-fast); }
.chat-question-mark[data-shape="dot"] { border-radius: 50%; }
.chat-question-mark[data-shape="box"] { border-radius: var(--radius-sm); }
.chat-question-mark[data-checked="true"] { border-color: var(--c-accent); background: var(--c-accent); color: var(--c-accent-text); }
.chat-question-opt-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.chat-question-opt-label { line-height: var(--leading-body); }
.chat-question-opt-desc { color: var(--c-text-2); font-size: var(--font-size-xs); line-height: var(--leading-code); }
.chat-question-key { flex: none; min-width: 18px; height: 18px; margin-top: 2px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); color: var(--c-text-3); font-size: var(--font-size-xs); font-variant-numeric: tabular-nums; }
.chat-question-opt:hover:not(:disabled) .chat-question-key { color: var(--c-text-2); }
.chat-question-custom { display: flex; align-items: flex-start; gap: var(--space-8); padding: var(--space-8) var(--space-12); background: var(--c-bg); border: 1px dashed var(--c-border); border-radius: var(--radius-md); transition: border-color var(--motion-fast), background var(--motion-fast); }
.chat-question-custom:focus-within, .chat-question-custom[data-active="true"] { border-style: solid; border-color: var(--c-accent-strong); background: var(--c-info-bg); }
.chat-question-input { flex: 1 1 auto; min-width: 0; max-height: 120px; padding: 0; background: transparent; border: none; color: var(--c-text); font: inherit; line-height: var(--leading-body); resize: none; overflow-y: auto; }
.chat-question-input:focus-visible { outline: none; }
.chat-question-input::placeholder { color: var(--c-text-3); }
.chat-question-actions { display: flex; align-items: center; gap: var(--space-8); }
.chat-question-spacer { flex: 1 1 auto; }
.chat-question-answer { display: flex; flex-direction: column; gap: var(--space-4); }
.chat-question-answer-list { display: flex; flex-wrap: wrap; gap: var(--space-4); }
.chat-question-chip { padding: 0 var(--space-8); background: var(--c-selection); border-radius: 999px; font-size: var(--font-size-xs); line-height: 20px; }
.chat-question-skip { color: var(--c-text-3); font-size: var(--font-size-xs); }
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
.chat-pill { position: absolute; left: 50%; bottom: var(--space-16); transform: translateX(-50%); padding: var(--space-4) var(--space-12); background: var(--c-accent); color: var(--c-accent-text); border: none; border-radius: 999px; font: inherit; font-size: var(--font-size-xs); font-variant-numeric: tabular-nums; cursor: pointer; z-index: var(--z-popover); }
/* 仅在可见（去掉 hidden）时套入场动画：hidden 翻转即触发，回落时动画随选择器失配撤销。 */
.chat-pill:not([hidden]) { animation: chat-pill-in var(--motion-fast) both; }
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
.chat-anchor { padding-top: var(--space-4); border-top: 1px solid var(--c-accent-strong); color: var(--c-accent-strong); font-size: var(--font-size-xs); text-align: center; transition: opacity var(--motion-base); }
.chat-workflow-meta { font-size: var(--font-size-xs); color: var(--c-text-2); }
/* 预算收口说明行：一行紧凑状态（stop_reason），无动画，避免布局抖动。 */
.chat-orchestration { display: flex; align-items: center; gap: var(--space-4); font-size: var(--font-size-xs); color: var(--c-text-3); }
.chat-orchestration[data-tone="stop"] { color: var(--c-warning); }
.chat-date { margin: var(--space-12) 0; text-align: center; font-size: var(--font-size-xs); color: var(--c-text-3); }
.chat-lightbox { position: fixed; inset: 0; z-index: var(--z-lightbox); display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--c-text) 28%, transparent); animation: chat-fade var(--motion-base) both; }
.chat-lightbox[data-closing="true"] { animation: chat-fade-out var(--motion-fast) both; }
.chat-lightbox-img { max-width: 90vw; max-height: 86vh; box-shadow: var(--shadow-pop); cursor: grab; }
.chat-lightbox-img[data-dragging="true"] { cursor: grabbing; }
.chat-lightbox-close { position: absolute; top: var(--space-16); right: var(--space-16); color: var(--c-text); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-sm); }
@keyframes chat-breathe { 0%, 100% { opacity: .25; } 50% { opacity: .6; } }
@keyframes chat-shimmer { from { background-position: 100% 0; } to { background-position: 0% 0; } }
@keyframes chat-working-pulse { 0%, 100% { opacity: .8; } 50% { opacity: 1; } }
@keyframes chat-dot { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
@keyframes chat-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes chat-fade-out { from { opacity: 1; } to { opacity: 0; } }
/* 展开区 / 浮层入场：轻微上移 + 淡入（含工具卡展开体、思考块、表格导出菜单）。 */
@keyframes chat-pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
/* 「回到底部」浮起钮：保留 translateX(-50%) 水平居中，仅叠加上浮淡入。 */
@keyframes chat-pill-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (prefers-reduced-motion: reduce) {
  /* 呼吸条 / 旋转为位移动效，减少动态时停用；「正在工作」仅色彩与透明度变化，保留以维持可辨识度。 */
  .chat-breathe, .chat-tool-spin, .chat-group-avatar[data-current="true"], .chat-tool-detail, .chat-reasoning-body, .chat-table-menu, .chat-pill:not([hidden]) { animation: none; }
  .chat-breathe, .chat-tool-spin, .chat-group-avatar[data-current="true"] { opacity: .4; }
  .chat-lightbox, .chat-lightbox[data-closing="true"] { animation: none; }
  .chat-list, .chat-footnote, .chat-tool-chevron, .chat-reasoning-chevron, .chat-anchor { transition: none; }
}
`
