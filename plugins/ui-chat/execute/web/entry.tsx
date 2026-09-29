// `ui-chat` 客户端半边（slot = main）：React 组件 + React-free store 绑定。
// 契约：`export const contract = '2'` + `register(ctx)` 把 App 注册进 main slot。
// 业务状态住 `thread-store`（快照 + 有序增量 + 定稿替换）；组件只渲染纯模块产出的视图模型。
// markdown 正文统一经 `Markdown`（全仓唯一 `dangerouslySetInnerHTML` 处）；流式与定稿同一管线。

import {
  Component,
  Fragment,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { SlotContext } from '@chrono/ui-contract'

import { STYLE_TEXT } from './styles.ts'
import { slotWriteCommand } from './slot-write.ts'
import { createMarkdownCache, renderMarkdownIncremental } from './markdown-cache.ts'
import type { MarkdownCache } from './markdown-cache.ts'
import { base64ToBytes, fitBox } from './media.ts'
import { tableToCsv, tableToMarkdown, tableToTsv } from './table-format.ts'
import { FALLBACK_MESSAGES, formatText, loadMessages, lookupMessage } from './messages.ts'
import type { MessageTable } from './messages.ts'
import {
  dataChangeTarget,
  hasPendingUserMessage,
  isPeriodicRun,
  matchesThread,
  messageId,
  messageText,
  subagentHeader,
} from './history-model.ts'
import {
  applyDelta,
  applyRunStarted,
  applySnapshot,
  applyToolDelta,
  applyToolEnd,
  applyToolStart,
  applyTurnPending,
  applyTurnSettled,
  clearPendingUser,
  createThreadStore,
  dropInFlight,
  emptyView,
  foldRunFinished,
  isStreaming,
  outcomeBlocks,
  outcomeDisplayCode,
  reconcilePendingUser,
  setPendingUser,
} from './thread-store.ts'
import { messageViewItems, pendingUserDef, safeStringify } from './render-parts.ts'
import { toolCardViewModel } from './tool-card.ts'
import { detailViewModel, questionAnswerList } from './detail-renderers.ts'
import { applyQuestionStates, collectQuestionItemIds } from './question-state.ts'
import { buildDateSeparators } from './date-sep.ts'
import { usageText } from './usage.ts'
import { COPY_HOLD_MS } from './copy.ts'
import { createLightboxState } from './lightbox.ts'
import { groupViewModel } from './group.ts'
import { stopReasonText } from './progress.ts'
import {
  clampWindow,
  dismissNew,
  hasOlder,
  initialWindow,
  newerWindow,
  olderWindow,
  onNewContent,
  pillLabel,
  shouldWindow,
  trimBottom,
  trimTop,
} from './windowing.ts'

export const contract = '2'

interface ChatEnv {
  ctx: SlotContext
  table: MessageTable
  announce(text: string): void
  openLightbox(payload: { url: string; alt: string; thumb: HTMLElement | null }): void
  openVideo(url: string): void
  submitQuestion(vm: any, answers: any[]): Promise<{ ok: boolean; code?: string }>
  copyText(def: any): Promise<{ ok: boolean }>
  retry(): void
}

const ChatCtx = createContext<ChatEnv | null>(null)

function useChatEnv(): ChatEnv {
  const env = useContext(ChatCtx)
  if (env === null) throw new Error('chat env missing')
  return env
}

interface BoundaryProps {
  children: ReactNode
  fallback: ReactNode
  resetKey?: string
}

interface BoundaryState {
  failed: boolean
  resetKey: string
}

/**
 * 单条消息的渲染异常边界：异常在本条内收束为降级提示，不冒泡崩掉整棵聊天树。
 * `resetKey` 变化（消息身份 / 内容随快照更新）时清掉失败态，使瞬时渲染错误可恢复。
 */
class MessageBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { failed: false, resetKey: props.resetKey ?? '' }
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    const resetKey = props.resetKey ?? ''
    if (resetKey !== state.resetKey) return { failed: false, resetKey }
    return null
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true }
  }

  componentDidCatch(): void {
    // 已由 getDerivedStateFromError 收束；此处只吞掉，不重抛。
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** 边界兜底：渲染失败时的人话提示（不空白、不报错）。 */
function RenderFallback(): ReactNode {
  const { table } = useChatEnv()
  return (
    <div className="chat-system">
      <div>{lookupMessage(table, 'chat_render_failed').body}</div>
    </div>
  )
}

// ---- 原子组件 ----

function Icon({
  name,
  size = 16,
  label = '',
  className,
}: {
  name: string
  size?: number
  label?: string
  className?: string
}): ReactNode {
  const { ctx } = useChatEnv()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label.length > 0 ? 'img' : undefined}
      aria-label={label.length > 0 ? label : undefined}
      aria-hidden={label.length > 0 ? undefined : true}
    >
      <use href={`${ctx.tokens.icons}#${name}`} />
    </svg>
  )
}

function IconButton({
  name,
  label,
  onClick,
  size = 16,
  dataCopy,
}: {
  name: string
  label: string
  onClick?: () => void
  size?: number
  dataCopy?: string
}): ReactNode {
  return (
    <button
      type="button"
      className="chat-iconbtn"
      aria-label={label}
      title={label}
      data-copy={dataCopy}
      onClick={onClick}
    >
      <Icon name={name} size={size} label={label} />
    </button>
  )
}

/** 同步代码块展开 / 收起按钮的文案与 aria 状态（markdown 产物无状态，渲染后补齐、点击后就地更新）。 */
function syncCodeToggle(button: HTMLButtonElement, collapsed: boolean, table: MessageTable): void {
  const label = lookupMessage(table, collapsed ? 'chat_code_expand' : 'chat_code_collapse').body
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  button.title = label
}

/** 表格 → 二维文本矩阵（首个 tr 是表头，按 DOM 顺序取 th / td 文本）。 */
function tableMatrix(table: HTMLTableElement): string[][] {
  const rows: string[][] = []
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    rows.push(Array.from(tr.querySelectorAll('th, td')).map((cell) => (cell.textContent ?? '').trim()))
  }
  return rows
}

/** 触发浏览器下载（Blob + 隐藏 a[download]），随后释放对象 URL。 */
function downloadText(fileName: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * 贴底：写入超大 scrollTop，由浏览器夹到最大滚动位。
 * 免读 `scrollHeight`——流式每帧「读高度再写滚动」会强制同步布局（jank 主因之一）。
 */
function pinToBottom(el: HTMLElement | null): void {
  if (el !== null) el.scrollTop = Number.MAX_SAFE_INTEGER
}

/** 收起表格导出菜单（可保留 `except` 所在的块）。 */
function closeTableMenus(root: ParentNode, except: Element | null = null): void {
  for (const block of Array.from(root.querySelectorAll('.chat-tableblock.chat-menu-open'))) {
    if (block === except) continue
    block.classList.remove('chat-menu-open')
    const button = block.querySelector('.chat-table-export')
    if (button !== null) button.setAttribute('aria-expanded', 'false')
  }
}

/**
 * 渲染后就地补本地化 label / title（markdown 产物是纯字符串，渲染器拿不到文案表）。
 * 按「片」调用：每帧只需扫尾部片，前缀片仅在跨边界时扫一次。
 */
function relabelPart(root: HTMLElement | null, table: MessageTable): void {
  if (root === null) return
  const label = lookupMessage(table, 'chat_copy').body
  for (const btn of root.querySelectorAll<HTMLButtonElement>('.chat-codeblock-copy')) {
    if (btn.getAttribute('aria-label') === null) {
      btn.setAttribute('aria-label', label)
      btn.title = label
    }
  }
  for (const btn of root.querySelectorAll<HTMLButtonElement>('.chat-codeblock-toggle')) {
    const block = btn.closest('.chat-codeblock')
    syncCodeToggle(btn, block !== null && block.getAttribute('data-collapsed') === 'true', table)
  }
  // 表格工具条：复制 / 导出按钮补 label，导出菜单项补可见文案。
  for (const btn of root.querySelectorAll<HTMLButtonElement>('.chat-table-copy')) {
    if (btn.getAttribute('aria-label') === null) {
      btn.setAttribute('aria-label', label)
      btn.title = label
    }
  }
  const exportLabel = lookupMessage(table, 'chat_export').body
  for (const btn of root.querySelectorAll<HTMLButtonElement>('.chat-table-export')) {
    btn.setAttribute('aria-label', exportLabel)
    btn.title = exportLabel
  }
  const menuLabels: [string, string][] = [
    ['.chat-table-export-csv', lookupMessage(table, 'chat_export_csv').body],
    ['.chat-table-export-md', lookupMessage(table, 'chat_export_markdown').body],
  ]
  for (const [selector, text] of menuLabels) {
    for (const btn of root.querySelectorAll<HTMLButtonElement>(selector)) btn.textContent = text
  }
}

/**
 * 全仓唯一 `dangerouslySetInnerHTML` 处：markdown 渲染 + 白名单消毒。
 * 经增量缓存（`renderMarkdownIncremental`）——流式时已完成前缀只解析一次，只重解析尾部块。
 * 前缀 / 尾部注入两个并列节点：前缀字符串跨帧稳定（React 不会重写它），每帧只重写尾部节点。
 * 若合成单个字符串注入，React 每帧会把整条消息的 DOM 拆掉重建——长回答越写越卡（O(n²)）。
 * 缓存更新走 effect，不在渲染期改 ref。`live` = 文本仍在流式在途，尾部走有界渲染。
 */
function Markdown({
  text,
  className,
  live = false,
}: {
  text: unknown
  className?: string
  live?: boolean
}): ReactNode {
  const env = useChatEnv()
  const cacheRef = useRef<MarkdownCache | null>(null)
  if (cacheRef.current === null) cacheRef.current = createMarkdownCache()
  const parts = useMemo(
    () => renderMarkdownIncremental(text, cacheRef.current as MarkdownCache, live),
    [text, live],
  )
  useEffect(() => {
    cacheRef.current = parts.cache
  }, [parts.cache])
  const prefixRef = useRef<HTMLDivElement | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    relabelPart(prefixRef.current, env.table)
  }, [env.table, parts.prefixHtml])
  useEffect(() => {
    relabelPart(tailRef.current, env.table)
  }, [env.table, parts.tailHtml])
  return (
    <div className={className ?? 'chat-md'}>
      <div
        className="chat-md-part"
        ref={prefixRef}
        dangerouslySetInnerHTML={{ __html: parts.prefixHtml }}
      />
      {/* 尾部为空（定稿 / 无未完成块）时不挂空节点：否则前缀片不再是 :last-child，
          消息末尾会残留一个段间距。 */}
      {parts.tailHtml.length > 0 ? (
        <div
          className="chat-md-part"
          ref={tailRef}
          dangerouslySetInnerHTML={{ __html: parts.tailHtml }}
        />
      ) : null}
    </div>
  )
}

/** base64 字节 + mime → blob URL（对象 URL 由调用方 revoke）。 */
function blobUrlFromBytes(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
}

/** 资产引用 → 可显示的 URL（asset 经 `ctx.asset.get` 取 base64 转 blob URL；ext 直用）。 */
function useAssetUrl(source: any, nonce: number): string | null {
  const { ctx } = useChatEnv()
  const key =
    source === null || source === undefined
      ? ''
      : `${source.kind}:${source.sha256 ?? ''}:${source.url ?? ''}`
  const [url, setUrl] = useState<string | null>(
    source !== null && source !== undefined && source.kind === 'ext' && typeof source.url === 'string'
      ? source.url
      : null,
  )
  useEffect(() => {
    if (source === null || source === undefined) {
      setUrl(null)
      return undefined
    }
    if (source.kind === 'ext') {
      setUrl(typeof source.url === 'string' ? source.url : null)
      return undefined
    }
    let alive = true
    let created: string | null = null
    setUrl(null)
    void ctx.asset
      .get(source.sha256)
      .then((res) => {
        if (!alive) return
        const record = res as any
        if (record !== null && record.ok === true && typeof record.bytes === 'string') {
          const mime =
            typeof record.mime === 'string' && record.mime.length > 0
              ? record.mime
              : typeof source.mime === 'string' && source.mime.length > 0
                ? source.mime
                : 'application/octet-stream'
          created = blobUrlFromBytes(base64ToBytes(record.bytes), mime)
          if (!alive) {
            URL.revokeObjectURL(created)
            return
          }
          setUrl(created)
        } else {
          setUrl(null)
        }
      })
      .catch(() => {
        if (alive) setUrl(null)
      })
    return () => {
      alive = false
      if (created !== null) URL.revokeObjectURL(created)
    }
  }, [key, nonce])
  return url
}

function MediaPlaceholder({ onRetry }: { onRetry: () => void }): ReactNode {
  const { table } = useChatEnv()
  return (
    <div className="chat-placeholder">
      <Icon name="alert-circle" size={16} />
      <span>{lookupMessage(table, 'chat_media_failed').body}</span>
      <button type="button" className="chat-btn" onClick={onRetry}>
        {lookupMessage(table, 'chat_retry').body}
      </button>
    </div>
  )
}

function MediaImage({ source, alt }: { source: any; alt: string }): ReactNode {
  const env = useChatEnv()
  const [nonce, setNonce] = useState(0)
  const [failed, setFailed] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const url = useAssetUrl(source, nonce)

  // 解码前先探测自然尺寸，预留精确显示盒，消除懒加载解码引起的布局跳动。
  useEffect(() => {
    setDims(null)
    if (url === null) return undefined
    let alive = true
    const probe = new Image()
    probe.onload = () => {
      if (alive && probe.naturalWidth > 0 && probe.naturalHeight > 0) {
        setDims({ w: probe.naturalWidth, h: probe.naturalHeight })
      }
    }
    probe.src = url
    return () => {
      alive = false
    }
  }, [url])

  if (url === null || failed) {
    return (
      <MediaPlaceholder
        onRetry={() => {
          setFailed(false)
          setNonce((value) => value + 1)
        }}
      />
    )
  }
  const altText = alt.length > 0 ? alt : lookupMessage(env.table, 'chat_image').body
  const img = (
    <img
      className="chat-media-img"
      src={url}
      alt={altText}
      loading="lazy"
      onClick={(event) => {
        event.stopPropagation()
        env.openLightbox({ url, alt: altText, thumb: event.currentTarget })
      }}
      onError={() => setFailed(true)}
    />
  )
  const box = fitBox(dims, 320, 240)
  if (box === null) return img
  return (
    <span className="chat-media-frame" style={{ width: box.w, height: box.h }}>
      {img}
    </span>
  )
}

function MediaVideo({ source }: { source: any }): ReactNode {
  const env = useChatEnv()
  const [nonce, setNonce] = useState(0)
  const [failed, setFailed] = useState(false)
  const url = useAssetUrl(source, nonce)
  if (url === null || failed) {
    return (
      <MediaPlaceholder
        onRetry={() => {
          setFailed(false)
          setNonce((value) => value + 1)
        }}
      />
    )
  }
  return (
    <div className="chat-video-thumb">
      <video className="chat-media-video" src={url} preload="metadata" muted onError={() => setFailed(true)} />
      <button type="button" className="chat-video-play" onClick={() => env.openVideo(url)}>
        {lookupMessage(env.table, 'chat_play_video').body}
      </button>
    </div>
  )
}

function MediaAudio({ source }: { source: any }): ReactNode {
  const [nonce, setNonce] = useState(0)
  const [failed, setFailed] = useState(false)
  const url = useAssetUrl(source, nonce)
  if (url === null || failed) {
    return (
      <MediaPlaceholder
        onRetry={() => {
          setFailed(false)
          setNonce((value) => value + 1)
        }}
      />
    )
  }
  return <audio className="chat-media-audio" src={url} controls preload="none" onError={() => setFailed(true)} />
}

function FileCard({ name, source }: { name: string; source: any }): ReactNode {
  const [nonce, setNonce] = useState(0)
  const url = useAssetUrl(source, nonce)
  const inner = (
    <>
      <Icon name="paperclip" size={16} />
      <span className="chat-file-name">{name}</span>
    </>
  )
  if (url === null) {
    // 资产取回失败给带重试的占位；ext（URL 已过 safeUrl）或非资产回落纯卡片。
    if (source !== null && source !== undefined && source.kind === 'asset') {
      return <MediaPlaceholder onRetry={() => setNonce((value) => value + 1)} />
    }
    return <div className="chat-file">{inner}</div>
  }
  return (
    <a className="chat-file" href={url} target="_blank" rel="noopener noreferrer" download={name}>
      {inner}
    </a>
  )
}

function TerminalView({ vm }: { vm: any }): ReactNode {
  const children: ReactNode[] = []
  if (vm.stdout.length > 0) children.push(<div key="out" className="chat-terminal-stdout">{vm.stdout}</div>)
  if (vm.stderr.length > 0) children.push(<div key="err" className="chat-terminal-stderr">{vm.stderr}</div>)
  if (vm.exitText.length > 0) children.push(<div key="exit" className="chat-terminal-exit">{vm.exitText}</div>)
  if (children.length === 0) children.push(<div key="breathe" className="chat-breathe" />)
  return <div className="chat-terminal">{children}</div>
}

function DiffView({ vm }: { vm: any }): ReactNode {
  return (
    <div className="chat-diff">
      {vm.rows.map((row: any, index: number) => {
        if (row.type === 'hunk') {
          return <div key={index} className="chat-diff-row chat-diff-hunk">{row.text}</div>
        }
        if (row.type === 'mod') {
          return <div key={index} className="chat-diff-row chat-diff-mod">{row.text}</div>
        }
        const tone = row.type === 'add' ? 'add' : row.type === 'del' ? 'del' : 'ctx'
        return (
          <div key={index} className={`chat-diff-row chat-diff-${tone}`}>
            {row.prefix}
            {row.text}
          </div>
        )
      })}
    </div>
  )
}

/**
 * question 交互卡：逐题向导。题目与选项全部由模型给出，系统只额外提供「自定义答案」输入。
 * 逐题推进（第 i / N 个问题）、上一题 / 下一题、忽略（跳过本题）、末题提交；已答折叠；
 * expired 禁用；interactive:false 只读。
 */
function QuestionCard({ vm }: { vm: any }): ReactNode {
  const env = useChatEnv()
  // answered / answers 从 vm 派生，本地提交只作覆盖层：快照回流（他处作答 / 重拉）不再脱节。
  const [localAnswers, setLocalAnswers] = useState<any[] | null>(null)
  const answered = vm.answered === true || localAnswers !== null
  const readOnly = vm.interactive === false
  // 本地提交作覆盖层，快照回流前也能显示刚提交的答案。
  const answers = localAnswers !== null ? localAnswers : vm.answers
  const questions: any[] = Array.isArray(vm.questions) ? vm.questions : []
  const [step, setStep] = useState(0)
  const [selections, setSelections] = useState<{ [id: string]: string[] }>(() => {
    const init: { [id: string]: string[] } = {}
    for (const question of questions) init[question.id] = []
    return init
  })
  const [customs, setCustoms] = useState<{ [id: string]: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // 同步闩：state 更新是异步的，双击会在同一渲染帧内穿透 submitting 检查。
  const submittingRef = useRef(false)

  if (answered) {
    return (
      <div className="chat-question" data-answered="true">
        {questions.map((question: any) => {
          const pieces = questionAnswerList(answers, question.id)
          return (
            <div key={question.id} className="chat-question-answer">
              <div className="chat-question-q">{question.header || question.question}</div>
              {pieces.length > 0 ? (
                <div className="chat-question-answer-list">
                  {pieces.map((piece: string, index: number) => (
                    <span key={index} className="chat-question-chip">
                      {piece}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="chat-question-skip">{lookupMessage(env.table, 'chat_ignored').body}</span>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // 只读展示：不渲染选择 / 自定义输入 / 提交，避免对不可交互的问题写回答。
  if (readOnly) {
    return (
      <div className="chat-question" data-readonly="true">
        {questions.map((question: any) => (
          <div key={question.id} className="chat-question-group">
            {question.header.length > 0 ? <div className="chat-question-q">{question.header}</div> : null}
            {question.question.length > 0 ? <div className="chat-question-text">{question.question}</div> : null}
            {question.options.length > 0 ? (
              <div className="chat-question-opts">
                {question.options.map((option: any) => (
                  <div key={option.label} className="chat-question-opt" data-readonly="true">
                    <span className="chat-question-mark" data-shape={question.multiple ? 'box' : 'dot'} aria-hidden="true" />
                    <span className="chat-question-opt-body">
                      <span className="chat-question-opt-label">{option.label}</span>
                      {option.description.length > 0 ? (
                        <span className="chat-question-opt-desc">{option.description}</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    )
  }

  const total = questions.length
  if (total === 0) return <div className="chat-question" data-readonly="true" />
  const current = questions[Math.min(step, total - 1)]
  const isLast = step >= total - 1
  const currentSelection = selections[current.id] ?? []
  const customEnabled = current.custom !== false
  const currentCustom = customs[current.id] ?? ''
  const customChecked = currentCustom.trim().length > 0

  const toggle = (label: string) => {
    if (vm.expired) return
    setError(null)
    setSelections((previous) => {
      const next: { [id: string]: string[] } = { ...previous, [current.id]: [...(previous[current.id] ?? [])] }
      const set = new Set(next[current.id])
      if (current.multiple) {
        if (set.has(label)) set.delete(label)
        else set.add(label)
      } else {
        set.clear()
        set.add(label)
      }
      next[current.id] = [...set]
      return next
    })
    // 单选：选项与自定义互斥，选选项即清掉本题自定义输入。
    if (!current.multiple) setCustoms((previous) => ({ ...previous, [current.id]: '' }))
  }

  const changeCustom = (value: string) => {
    if (vm.expired) return
    setError(null)
    setCustoms((previous) => ({ ...previous, [current.id]: value }))
    // 单选：自定义有内容即视为选中它，清掉本题选项。
    if (!current.multiple && value.trim().length > 0) {
      setSelections((previous) => ({ ...previous, [current.id]: [] }))
    }
  }

  const goTo = (next: number) => {
    if (next < 0 || next >= total) return
    setError(null)
    setStep(next)
  }

  /** 收集作答；`excludeId` 用于忽略本题时排除它。空答的问题不入列。 */
  const collect = (excludeId?: string): any[] => {
    const collected: any[] = []
    for (const question of questions) {
      if (question.id === excludeId) continue
      const selected = selections[question.id] ?? []
      const custom = (customs[question.id] ?? '').trim()
      if (selected.length === 0 && custom.length === 0) continue
      const answer: any = { question_id: question.id, selected }
      if (custom.length > 0) answer.custom = custom
      collected.push(answer)
    }
    return collected
  }

  const submit = async (excludeId?: string, allowEmpty = false) => {
    if (vm.expired || submittingRef.current) return
    const collected = collect(excludeId)
    if (collected.length === 0 && !allowEmpty) {
      setError(lookupMessage(env.table, 'chat_answer_required').body)
      return
    }
    submittingRef.current = true
    setError(null)
    setSubmitting(true)
    const result = await env.submitQuestion(vm, collected)
    if (result.ok) {
      setLocalAnswers(
        collected.map((answer) => ({
          questionId: answer.question_id,
          selected: answer.selected,
          custom: answer.custom ?? null,
        })),
      )
      return
    }
    submittingRef.current = false
    setSubmitting(false)
    setError(lookupMessage(env.table, result.code ?? 'unknown').body)
  }

  const advance = () => {
    if (isLast) void submit()
    else goTo(step + 1)
  }

  /** 忽略本题：清掉本题作答后推进；末题则直接提交其余作答。 */
  const ignoreCurrent = () => {
    if (vm.expired || submittingRef.current) return
    setSelections((previous) => ({ ...previous, [current.id]: [] }))
    setCustoms((previous) => ({ ...previous, [current.id]: '' }))
    if (!isLast) {
      goTo(step + 1)
      return
    }
    // 忽略本题：末题时即便其余全空也提交（question.answer 接受空 answers），让 agent 继续。
    void submit(current.id, true)
  }

  /** 多行输入随内容长高（先归零再按 scrollHeight 撑开）。 */
  const autoGrow = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }

  /** 数字键 1–9 速选当前题选项，Enter 推进 / 提交；焦点在文本框时交还原生行为。 */
  const onCardKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (vm.expired) return
    const target = event.target as HTMLElement
    const tag = target.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return
    if (/^[1-9]$/.test(event.key)) {
      const option = current.options[Number(event.key) - 1]
      if (option !== undefined) {
        event.preventDefault()
        toggle(option.label)
      }
      return
    }
    // 焦点在选项按钮上时 Enter 归按钮（触发选择），不在此重复推进。
    if (event.key === 'Enter' && tag !== 'BUTTON') {
      event.preventDefault()
      advance()
    }
  }

  return (
    <div className="chat-question" data-expired={String(vm.expired)} onKeyDown={onCardKeyDown}>
      {vm.expired ? (
        <div className="chat-warning-inline">
          <Icon name="alert-triangle" size={16} />
          <span>{lookupMessage(env.table, 'chat_expired').body}</span>
        </div>
      ) : null}
      <div className="chat-question-head">
        <span className="chat-question-icon" aria-hidden="true">
          <Icon name="info" size={16} />
        </span>
        <span className="chat-question-heading">{current.header || current.question}</span>
        <span className="chat-question-badge">
          {lookupMessage(env.table, current.multiple ? 'chat_question_multiple' : 'chat_question_single').body}
        </span>
      </div>
      {current.header.length > 0 && current.question.length > 0 ? (
        <div className="chat-question-text">{current.question}</div>
      ) : null}
      {total > 1 ? (
        <div className="chat-question-nav">
          <span className="chat-question-progress">
            <span className="chat-question-dots" aria-hidden="true">
              {questions.map((question: any, index: number) => (
                <span
                  key={question.id}
                  className="chat-question-dot"
                  data-state={index === step ? 'current' : index < step ? 'done' : 'todo'}
                />
              ))}
            </span>
            {formatText('chat_question_progress', { index: step + 1, total })}
          </span>
          <div className="chat-question-nav-btns">
            <button
              type="button"
              className="chat-question-nav-btn"
              disabled={vm.expired || step <= 0}
              aria-label={lookupMessage(env.table, 'chat_prev_question').body}
              onClick={() => goTo(step - 1)}
            >
              ‹
            </button>
            <button
              type="button"
              className="chat-question-nav-btn"
              disabled={vm.expired || isLast}
              aria-label={lookupMessage(env.table, 'chat_next_question').body}
              onClick={() => goTo(step + 1)}
            >
              ›
            </button>
          </div>
        </div>
      ) : null}
      <div
        className="chat-question-group"
        role={current.multiple ? 'group' : 'radiogroup'}
        aria-label={current.header || current.question}
      >
        {current.options.length > 0 ? (
          <div className="chat-question-opts">
            {current.options.map((option: any, index: number) => {
              const checked = currentSelection.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  className="chat-question-opt"
                  role={current.multiple ? 'checkbox' : 'radio'}
                  aria-checked={checked}
                  aria-disabled={vm.expired}
                  disabled={vm.expired}
                  onClick={() => toggle(option.label)}
                >
                  <span
                    className="chat-question-mark"
                    data-shape={current.multiple ? 'box' : 'dot'}
                    data-checked={String(checked)}
                    aria-hidden="true"
                  >
                    {checked ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span className="chat-question-opt-body">
                    <span className="chat-question-opt-label">{option.label}</span>
                    {option.description.length > 0 ? (
                      <span className="chat-question-opt-desc">{option.description}</span>
                    ) : null}
                  </span>
                  {index < 9 ? (
                    <span className="chat-question-key" aria-hidden="true">
                      {index + 1}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
        {customEnabled ? (
          <label className="chat-question-custom" data-active={String(customChecked)}>
            <span
              className="chat-question-mark"
              data-shape={current.multiple ? 'box' : 'dot'}
              data-checked={String(customChecked)}
              aria-hidden="true"
            >
              {customChecked ? <Icon name="check" size={12} /> : null}
            </span>
            <span className="chat-question-opt-body">
              <span className="chat-question-opt-label">{lookupMessage(env.table, 'chat_other').body}</span>
              <textarea
                key={current.id}
                className="chat-question-input"
                rows={1}
                placeholder={lookupMessage(env.table, 'chat_other_input').body}
                aria-label={`${lookupMessage(env.table, 'chat_other').body}：${current.header || current.question}`}
                disabled={vm.expired}
                value={currentCustom}
                onChange={(event) => {
                  changeCustom(event.target.value)
                  autoGrow(event.target)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    advance()
                  }
                }}
              />
            </span>
          </label>
        ) : null}
      </div>
      <div className="chat-question-actions">
        <button
          type="button"
          className="chat-btn"
          disabled={vm.expired || submitting}
          onClick={ignoreCurrent}
        >
          {lookupMessage(env.table, 'chat_ignore').body}
        </button>
        <span className="chat-question-spacer" />
        <button
          type="button"
          className="chat-btn chat-btn-accent"
          disabled={vm.expired || submitting}
          onClick={advance}
        >
          {submitting
            ? lookupMessage(env.table, 'chat_submitting').body
            : isLast
              ? lookupMessage(env.table, 'chat_submit').body
              : lookupMessage(env.table, 'chat_next').body}
        </button>
        {error !== null ? <span className="chat-danger-inline">{error}</span> : null}
      </div>
    </div>
  )
}

function DetailView({ detail }: { detail: any }): ReactNode {
  const vm = detailViewModel(detail)
  switch (vm.kind) {
    case 'text':
      return <Markdown text={vm.text} />
    case 'code':
      return <pre className="chat-code-block">{vm.text}</pre>
    case 'diff':
      return <DiffView vm={vm} />
    case 'matches':
      return (
        <div className="chat-matches">
          {vm.items.map((item: any, index: number) => (
            <div key={index} className="chat-match">
              <div className="chat-match-head">
                <span className="chat-matches-line">{`${item.path}:${item.line}`}</span>
                {item.count > 1 ? <span className="chat-match-count">{`×${item.count}`}</span> : null}
              </div>
              {item.before.map((line: string, lineIndex: number) => (
                <div key={`before-${lineIndex}`} className="chat-match-context">
                  {line}
                </div>
              ))}
              <div className="chat-match-hit">{item.text}</div>
              {item.after.map((line: string, lineIndex: number) => (
                <div key={`after-${lineIndex}`} className="chat-match-context">
                  {line}
                </div>
              ))}
            </div>
          ))}
        </div>
      )
    case 'paths':
      return (
        <div className="chat-paths">
          {vm.items.map((item: string, index: number) => (
            <div key={index}>
              <Icon name="folder" size={16} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      )
    case 'list':
      return (
        <ul className="chat-list-detail">
          {vm.items.map((item: any, index: number) => (
            <li key={index}>{typeof item === 'string' ? item : safeStringify(item)}</li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <table className="chat-table">
          {vm.columns.length > 0 ? (
            <thead>
              <tr>
                {vm.columns.map((column: string, index: number) => (
                  <th key={index}>{column}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {vm.rows.map((row: string[], index: number) => (
              <tr key={index}>
                {row.map((cell: string, cellIndex: number) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'json':
      return <pre className="chat-code-block">{vm.text}</pre>
    case 'file':
      return <FileCard name={vm.name} source={vm.source} />
    case 'image':
      return <MediaImage source={vm.source} alt="" />
    case 'terminal':
      return <TerminalView vm={vm} />
    case 'question':
      return <QuestionCard vm={vm} />
    default:
      return <Markdown text={vm.text ?? ''} />
  }
}

/**
 * 推理折叠块：头部给「推理」标签（流式中带呼吸点），展开为内嵌灰底 markdown。
 * 流式中默认展开、收流即收起；用户点击后以点击为准（open 非 null 时不再自动跟随）。
 * 推理只作展示，不进模型上下文（由 context-window 丢弃）。
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const { table } = useChatEnv()
  const [open, setOpen] = useState<boolean | null>(null)
  if (text.length === 0) return null
  const expanded = open !== null ? open : streaming
  return (
    <div className="chat-reasoning" data-open={String(expanded)}>
      <button
        type="button"
        className="chat-reasoning-head"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        <Icon name="brain" size={14} className="chat-reasoning-icon" />
        <span className="chat-reasoning-label">{lookupMessage(table, 'chat_reasoning').body}</span>
        {streaming ? (
          <span className="chat-tool-status" data-state="running">
            <span className="chat-tool-spin" />
          </span>
        ) : null}
        <Icon name="chevron-right" size={16} className="chat-reasoning-chevron" />
      </button>
      {expanded ? (
        <div className="chat-reasoning-body">
          <Markdown text={text} live={streaming} />
        </div>
      ) : null}
    </div>
  )
}

/** 工具卡状态角标：运行中呼吸点 / 成功勾 / 失败叹号；未知（历史卡无状态）不显示。 */
function ToolStatus({ state }: { state: string | null }): ReactNode {
  if (state === null) return null
  if (state === 'running') {
    return (
      <span className="chat-tool-status" data-state="running">
        <span className="chat-tool-spin" />
      </span>
    )
  }
  return (
    <span className="chat-tool-status" data-state={state}>
      <Icon name={state === 'ok' ? 'check' : 'alert-circle'} size={14} />
    </span>
  )
}

/**
 * 工具卡：`line` 一行不可展开；`card` 折叠头 + 展开体。
 * 收起态 summary 展示调用输入（args）；展开体优先给流式输出（`render.live` 且已有 chunks），
 * 否则渲染描述符与结果合并后的 detail（在途卡 `tool.end` 即带结果、定稿卡读已落盘 part）。
 */
function ToolCard({
  vm,
  live,
}: {
  vm: any
  live?: { chunks: string; done: boolean; ok: boolean | null } | null
}): ReactNode {
  const [open, setOpen] = useState<boolean | null>(null)
  if (vm.form === 'degraded') return <Markdown text={vm.text} />
  const streaming = live !== null && live !== undefined
  const state = streaming
    ? live.done !== true
      ? 'running'
      : live.ok === false
        ? 'error'
        : live.ok === true
          ? 'ok'
          : null
    : vm.status
  if (vm.form === 'line') {
    return (
      <div className="chat-tool chat-tool-line" data-tone={vm.tone}>
        <Icon name={vm.icon} size={14} className="chat-tool-icon" />
        <span className="chat-tool-label">{vm.label}</span>
        <span className="chat-tool-summary">{vm.summary}</span>
        <ToolStatus state={state} />
      </div>
    )
  }
  const liveBody = streaming && vm.live === true && live.chunks.length > 0
  // 有流式输出的在途卡默认展开（跑完即收）；其余默认折叠（open 未被交互时为 null）。
  const expanded = open !== null ? open : liveBody && live.done !== true
  return (
    <div className={`chat-tool chat-tool-card chat-tool-${vm.tone}`} data-open={String(expanded)}>
      <button
        type="button"
        className="chat-tool-head"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        <Icon name={vm.icon} size={14} className="chat-tool-icon" />
        <span className="chat-tool-label">{vm.label}</span>
        <span className="chat-tool-summary">{vm.summary}</span>
        <ToolStatus state={state} />
        <Icon name="chevron-right" size={16} className="chat-tool-chevron" />
      </button>
      {expanded ? (
        <div className="chat-tool-detail">
          {liveBody ? (
            <div className="chat-terminal">
              <div className="chat-terminal-stdout">{live.chunks}</div>
            </div>
          ) : vm.detail !== null ? (
            <DetailView detail={vm.detail} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CopyButton({ def }: { def: any }): ReactNode {
  const env = useChatEnv()
  const [state, setState] = useState<'idle' | 'check' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  const hold = (next: 'check' | 'error') => {
    // 每次尝试先清旧计时器：成功 / 失败都自动回退到 idle，错误态不再永久驻留。
    if (timer.current !== null) clearTimeout(timer.current)
    setState(next)
    timer.current = setTimeout(() => {
      timer.current = null
      setState('idle')
    }, COPY_HOLD_MS)
  }
  return (
    <>
      <IconButton
        name={state === 'check' ? 'check' : state === 'error' ? 'alert-circle' : 'copy'}
        label={lookupMessage(env.table, 'chat_copy').body}
        dataCopy={state}
        onClick={() => {
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = null
          void env.copyText(def).then((result) => {
            hold(result.ok ? 'check' : 'error')
          })
        }}
      />
      {state === 'error' ? (
        <span className="chat-danger-inline">{lookupMessage(env.table, 'chat_copy_failed').body}</span>
      ) : null}
    </>
  )
}

function Footnote({ def, showRetry }: { def: any; showRetry: boolean }): ReactNode {
  const env = useChatEnv()
  const usage = usageText(def)
  return (
    <div className="chat-footnote">
      {usage !== null ? <span className="chat-usage">{usage}</span> : null}
      <CopyButton def={def} />
      {showRetry ? (
        <IconButton
          name="rotate-ccw"
          label={lookupMessage(env.table, 'chat_retry').body}
          onClick={() => env.retry()}
        />
      ) : null}
    </div>
  )
}

function RenderItem({ vm }: { vm: any }): ReactNode {
  if (vm.type === 'text') return <Markdown text={vm.text} />
  if (vm.type === 'reasoning') return <ReasoningBlock text={vm.text} streaming={false} />
  if (vm.type === 'image') return <MediaImage source={vm.source} alt={vm.alt ?? ''} />
  if (vm.type === 'video') return <MediaVideo source={vm.source} />
  if (vm.type === 'audio') return <MediaAudio source={vm.source} />
  if (vm.type === 'file') return <FileCard name={vm.name} source={vm.source} />
  if (vm.type === 'tool') return <ToolCard vm={toolCardViewModel(vm)} />
  return <Markdown text={safeStringify(vm)} />
}

function MessageItem({ entry, announce }: { entry: any; announce: boolean }): ReactNode {
  const env = useChatEnv()
  const def = entry !== null && typeof entry === 'object' ? entry.def : null
  const role = def !== null && typeof def.role === 'string' ? def.role : 'assistant'
  if (role === 'user') {
    const items = messageViewItems(def)
    return (
      <div className="chat-msg chat-msg-user">
        <div className="chat-bubble-user">
          {items.length === 0 ? messageText(def) : null}
          {items.map((item: any, index: number) =>
            item.type === 'text' ? <div key={index}>{item.text}</div> : <RenderItem key={index} vm={item} />,
          )}
        </div>
        <Footnote def={def} showRetry={false} />
      </div>
    )
  }
  if (role === 'system') {
    const errorCode =
      def !== null && def.meta !== undefined && def.meta !== null && typeof def.meta.error === 'string'
        ? def.meta.error
        : 'unknown'
    return (
      <div className="chat-msg chat-msg-assistant">
        <div className="chat-system">
          <div className="chat-error-title">
            {lookupMessage(env.table, errorCode).title || lookupMessage(env.table, 'chat_system_message').body}
          </div>
          <div>{lookupMessage(env.table, errorCode).body}</div>
        </div>
      </div>
    )
  }
  const showRetry =
    def !== null && def.meta !== undefined && def.meta !== null && typeof def.meta.error === 'string'
  return (
    <div className="chat-msg chat-msg-assistant" aria-live={announce ? 'polite' : undefined}>
      <div className="chat-msg-assistant-body">
        {messageViewItems(def).map((item: any, index: number) => (
          <RenderItem key={index} vm={item} />
        ))}
      </div>
      <Footnote def={def} showRetry={showRetry} />
    </div>
  )
}

interface HistoryListProps {
  messages: any[]
  start: number
  end: number
  inFlightTurnId: string | null
  finalizeAnnounce: boolean
  revision: number
}

/**
 * 窗口内历史消息段（memo）：入参全取稳定引用（messages 数组 / 窗口边界 / 在途 turnId / revision）。
 * 流式期间只有 `inFlight` 变化、`messages` 数组与窗口不动 ⇒ 本组件整段跳过重渲，
 * 每个 delta 不再重建整窗元素树（长会话的主要 jank 源）。
 */
const HistoryList = memo(function HistoryList(props: HistoryListProps): ReactNode {
  const { messages, start, end, inFlightTurnId, finalizeAnnounce, revision } = props
  const nodes: ReactNode[] = []
  const slice = messages.slice(start, end)
  const lastEntry = messages.length > 0 ? messages[messages.length - 1] : null
  for (const item of buildDateSeparators(slice, new Date())) {
    if (item.type === 'date') {
      nodes.push(
        <div key={`date-${item.key}`} className="chat-date">
          {item.label}
        </div>,
      )
      continue
    }
    // 在途回合的助手消息由 StreamTurn 呈现；历史里同回合的旧快照不重复渲染。
    if (isInFlightTurnEntry(item.entry, inFlightTurnId)) continue
    const announce = finalizeAnnounce && item.entry === lastEntry && isAssistantEntry(item.entry)
    const entryId = messageId(item.entry)
    nodes.push(
      <MessageBoundary key={entryId} resetKey={`${entryId}:${revision}`} fallback={<RenderFallback />}>
        <MessageItem entry={item.entry} announce={announce} />
      </MessageBoundary>,
    )
  }
  return <>{nodes}</>
})

/** 在途工具卡：完成（`tool.end`）即用结果本体渲染输出；未完成时只给流式输出。 */
function StreamToolCard({ tool }: { tool: any }): ReactNode {
  if (tool === null || tool === undefined) return null
  const done = tool.done === true
  const ok = tool.ok ?? null
  const status = done ? (ok === false ? 'error' : ok === true ? 'ok' : null) : null
  // 失败优先展示错误码（与定稿卡一致）；成功展示结果本体。
  const result = done ? (ok === false ? (tool.error ?? tool.result ?? null) : (tool.result ?? null)) : null
  const vm = toolCardViewModel({
    type: 'tool',
    callId: tool.callId,
    tool: tool.tool,
    render: tool.render,
    args: tool.args,
    result,
    status,
  })
  return <ToolCard vm={vm} live={{ chunks: tool.chunks, done, ok }} />
}

/** 流式回合的秒级计时：active 期间从 0 每秒步进，非 active 归零；计时器随组件卸载清理。 */
function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const started = Date.now()
    setSeconds(0)
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return seconds
}

/** 秒数 → 不足 1 分钟给 `5s`，之后给 `1m 5s`。 */
function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

function StreamTurn({ view }: { view: any }): ReactNode {
  const env = useChatEnv()
  const streaming = isStreaming(view)
  const seconds = useElapsedSeconds(streaming)
  const inFlight = view.inFlight
  if (inFlight === null) return null
  const toolsById = new Map(inFlight.tools.map((tool: any) => [tool.callId, tool]))
  const lastIndex = inFlight.segments.length - 1
  // 预算收口说明仍留在消息流（与本次回合终态绑定）；常规「编排进度」已移到输入卡下方状态栏。
  const stopNote = stopReasonText(inFlight.stopReason)
  return (
    <div className="chat-msg chat-msg-assistant" aria-busy={inFlight.cancelled === true ? undefined : true}>
      {inFlight.segments.map((segment: any, index: number) => {
        if (segment.kind === 'reasoning') {
          return (
            <ReasoningBlock key={`reasoning-${index}`} text={segment.text} streaming={streaming && index === lastIndex} />
          )
        }
        if (segment.kind === 'text') {
          return (
            <Markdown
              key={`text-${index}`}
              text={segment.text}
              className="chat-md chat-stream-text"
              live={streaming && index === lastIndex}
            />
          )
        }
        return <StreamToolCard key={segment.callId} tool={toolsById.get(segment.callId)} />
      })}
      {stopNote !== null ? (
        <div className="chat-orchestration" data-tone="stop" role="status">
          {stopNote}
        </div>
      ) : null}
      {inFlight.outcome !== null && inFlight.outcome.kind !== 'committed' ? (
        <TurnOutcomeLine outcome={inFlight.outcome} />
      ) : inFlight.suspended === true ? (
        <div className="chat-workflow-meta">{lookupMessage(env.table, 'chat_waiting').body}</div>
      ) : streaming ? (
        <div className="chat-working">
          <span>
            {lookupMessage(env.table, 'chat_working').body}
            <span className="chat-working-dots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </span>
          <span className="chat-working-time">{formatElapsed(seconds)}</span>
        </div>
      ) : inFlight.cancelled === true ? (
        <div className="chat-workflow-meta">{lookupMessage(env.table, 'chat_cancelled').body}</div>
      ) : null}
    </div>
  )
}

/** 回合结局块：非 committed 的持久 / 在途结局按种类与码渲染，不落回成功、不静默消失。 */
function TurnOutcomeLine({ outcome }: { outcome: any }): ReactNode {
  const { table } = useChatEnv()
  const code = outcomeDisplayCode(outcome)
  const entry = lookupMessage(table, code)
  const detail =
    typeof outcome.attributableTo === 'string' && outcome.attributableTo.length > 0
      ? ` ${formatText('chat_outcome_detail', { code, attribution: outcome.attributableTo })}`
      : ''
  return (
    <div className="chat-outcome" data-kind={outcome.kind}>
      <Icon name={outcome.kind === 'cancelled' ? 'x' : 'alert-circle'} size={16} />
      <div>
        <div className="chat-outcome-title">
          {entry.title || lookupMessage(table, 'chat_error').body}
        </div>
        <div>
          {entry.body}
          {detail}
        </div>
      </div>
    </div>
  )
}

function ErrorBar({ error, onRetry }: { error: any; onRetry: () => void }): ReactNode {
  const env = useChatEnv()
  const entry = lookupMessage(
    env.table,
    error !== null && typeof error.code === 'string' ? error.code : 'unknown',
  )
  return (
    <div className="chat-error">
      <Icon name="alert-circle" size={16} />
      <div>
        <div className="chat-error-title">
          {entry.title || lookupMessage(env.table, 'chat_error').body}
        </div>
        <div>{entry.body}</div>
      </div>
      <button type="button" className="chat-btn" onClick={onRetry}>
        {entry.action ?? lookupMessage(env.table, 'chat_retry').body}
      </button>
    </div>
  )
}

function GroupItemBody({ item }: { item: any }): ReactNode {
  const items = Array.isArray(item.items) ? item.items : []
  if (items.length === 0) return <Markdown text={item.text} />
  return (
    <>
      {items.map((vm: any, index: number) => (
        <RenderItem key={index} vm={vm} />
      ))}
    </>
  )
}

function Lightbox({ lb, onClose }: { lb: any; onClose: () => void }): ReactNode {
  const env = useChatEnv()
  const machine = lb.machine
  const [snap, setSnap] = useState<any>(() =>
    machine !== null ? machine.get() : { scale: 1, tx: 0, ty: 0 },
  )
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const drag = useRef({ dragging: false, x: 0, y: 0 })

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const root = overlayRef.current
      if (root === null) return
      const focusables = root.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0] as HTMLElement
      const last = focusables[focusables.length - 1] as HTMLElement
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  useEffect(() => {
    const img = imgRef.current
    if (img === null || machine === null) return undefined
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = machine.get()
      machine.zoomAt(
        current.scale * (event.deltaY < 0 ? 1.1 : 0.9),
        event.clientX - window.innerWidth / 2,
        event.clientY - window.innerHeight / 2,
      )
      setSnap(machine.get())
    }
    img.addEventListener('wheel', onWheel, { passive: false })
    return () => img.removeEventListener('wheel', onWheel)
  }, [machine])

  const closeButton = (
    <button
      ref={closeRef}
      type="button"
      className="chat-iconbtn chat-lightbox-close"
      aria-label={lookupMessage(env.table, 'chat_close').body}
      onClick={onClose}
    >
      <Icon name="x" size={16} label={lookupMessage(env.table, 'chat_close').body} />
    </button>
  )

  return (
    <div
      ref={overlayRef}
      className="chat-lightbox"
      data-closing={String(lb.closing === true)}
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === overlayRef.current) onClose()
      }}
    >
      {closeButton}
      {lb.kind === 'video' ? (
        <video className="chat-lightbox-img" src={lb.url} controls preload="metadata" />
      ) : (
        <img
          ref={imgRef}
          className="chat-lightbox-img"
          src={lb.url}
          alt={lb.alt}
          data-dragging={String(drag.current.dragging)}
          style={{ transform: `translate(${snap.tx}px, ${snap.ty}px) scale(${snap.scale})` }}
          onDoubleClick={(event) => {
            if (machine === null) return
            machine.toggleDoubleClick(
              event.clientX - window.innerWidth / 2,
              event.clientY - window.innerHeight / 2,
            )
            setSnap(machine.get())
          }}
          onPointerDown={(event) => {
            drag.current = { dragging: true, x: event.clientX, y: event.clientY }
            event.currentTarget.dataset.dragging = 'true'
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!drag.current.dragging || machine === null) return
            machine.pan(event.clientX - drag.current.x, event.clientY - drag.current.y)
            drag.current.x = event.clientX
            drag.current.y = event.clientY
            setSnap(machine.get())
          }}
          onPointerUp={(event) => {
            drag.current.dragging = false
            event.currentTarget.dataset.dragging = 'false'
          }}
          onPointerCancel={(event) => {
            drag.current.dragging = false
            event.currentTarget.dataset.dragging = 'false'
          }}
        />
      )}
    </div>
  )
}

// ---- 应用 ----

/** 身份视图 → data body；非身份视图（裸 body）原样返回。 */
function identityBodyOf(value: any): any {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'body')
    ? value.body
    : value
}

function isAssistantEntry(entry: any): boolean {
  const def = entry !== null && typeof entry === 'object' ? entry.def : null
  const role = def !== null && typeof def.role === 'string' ? def.role : 'assistant'
  return role !== 'user' && role !== 'system'
}

/**
 * 该历史条目是否为「当前在途回合」的助手消息：是则不渲染。
 * 在途块是该回合的实时权威呈现，历史里同回合的助手消息（承接帧先落盘所致）只是它的旧快照；
 * 两者同屏会重复呈现工具卡（观感像同一批工具被再次调用），定稿收口后在途块消失、历史消息即唯一。
 * 消息 id 形状 `msg-<conv>-<turnId>-assistant`（见 session store）。
 */
function isInFlightTurnEntry(entry: any, turnId: string | null): boolean {
  if (turnId === null || !isAssistantEntry(entry)) return false
  return messageId(entry).endsWith(`-${turnId}-assistant`)
}

function contentKey(view: any, hasPendingUser: boolean): string {
  const inFlight = view.inFlight
  const textLength = inFlight !== null ? inFlight.text.length : -1
  const reasoningLength = inFlight !== null ? inFlight.reasoning.length : -1
  const chunkLength =
    inFlight !== null
      ? inFlight.tools.reduce((total: number, tool: any) => total + (tool.chunks ? tool.chunks.length : 0), 0)
      : -1
  const toolCount = inFlight !== null ? inFlight.tools.length : -1
  const doneCount = inFlight !== null ? inFlight.tools.filter((tool: any) => tool.done === true).length : -1
  const cancelled = inFlight !== null && inFlight.cancelled === true ? 1 : 0
  return `${view.revision}|${view.messages.length}|${textLength}|${reasoningLength}|${chunkLength}|${toolCount}|${doneCount}|${cancelled}|${hasPendingUser ? 1 : 0}`
}

function App({
  ctx,
  store,
}: {
  ctx: SlotContext
  store: ReturnType<typeof createThreadStore>
}): ReactNode {
  const view = ctx.useStore(store) as any

  const stateRef = useRef<any>({
    viewThread: null,
    window: { start: 0, end: 0 },
    atBottom: true,
    loading: false,
    reloading: false,
    loadingNote: false,
    windowBusy: false,
    finalizeAnnounce: false,
    error: null,
    newMsg: { count: 0 },
    group: { unreadIds: new Set<string>(), anchorEl: null },
    connected: false,
    sawDisconnect: false,
    table: FALLBACK_MESSAGES as MessageTable,
    lightbox: null,
    listOpacity: 1,
  })
  const [, setTick] = useState(0)
  const rerender = useCallback(() => setTick((value) => value + 1), [])
  // 流式增量合帧：同一帧内到达的 model.delta / tool.delta 按到达序合并为一次 store 提交
  //（一帧最多一次重渲染 —— 否则工具刷屏输出会一包一渲染）。
  const pendingDeltas = useRef<Array<{ kind: 'delta' | 'tool'; payload: any }>>([])
  const flushScheduled = useRef(false)
  const flushDeltas = useCallback(() => {
    if (pendingDeltas.current.length === 0) return
    const queued = pendingDeltas.current
    pendingDeltas.current = []
    let next = store.getSnapshot()
    for (const op of queued) {
      next = op.kind === 'tool' ? applyToolDelta(next, op.payload) : applyDelta(next, op.payload)
    }
    store.commit(next, { type: 'delta' })
  }, [store])
  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return
    flushScheduled.current = true
    const run = () => {
      flushScheduled.current = false
      flushDeltas()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
  }, [flushDeltas])
  const [liveText, setLiveText] = useState('')
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingAdjust = useRef<{ prevHeight: number; prevTop: number } | null>(null)
  const pendingTrimTop = useRef(false)
  const pendingTrimBottom = useRef(false)
  const pendingScrollBottom = useRef(false)
  const scrollRaf = useRef(0)
  const lastKeyRef = useRef('')
  const disposedRef = useRef(false)
  const requestSeq = useRef(0)
  const apiRef = useRef<any>({})

  const announce = useCallback((text: string) => {
    setLiveText('')
    if (announceTimer.current !== null) clearTimeout(announceTimer.current)
    announceTimer.current = setTimeout(() => {
      setLiveText(text)
      announceTimer.current = setTimeout(() => setLiveText(''), 1500)
    }, 0)
  }, [])

  function scrollToBottom(): void {
    pinToBottom(scrollRef.current)
    stateRef.current.atBottom = true
    if (stateRef.current.newMsg.count !== 0) {
      stateRef.current.newMsg = dismissNew()
      rerender()
    }
  }

  async function loadHistory(conversationId: any, options: any = {}): Promise<void> {
    if (disposedRef.current) return
    // 请求序号：线程切换 / 重拉并发时只认最新一次回包，避免旧线程数据覆盖新视图。
    const seq = ++requestSeq.current
    const st = stateRef.current
    const resetView = options.resetView !== false
    const current = store.getSnapshot()
    const firstScreen = current.revision === 0 && current.messages.length === 0
    st.error = null
    if (firstScreen) {
      st.loading = true
      st.loadingNote = false
    } else {
      st.reloading = true
    }
    rerender()
    let loadingTimer: ReturnType<typeof setTimeout> | null = null
    if (firstScreen) {
      loadingTimer = setTimeout(() => {
        if (stateRef.current.loading) {
          stateRef.current.loadingNote = true
          rerender()
        }
      }, 8000)
      ;(loadingTimer as any).unref?.()
    }
    const args: any =
      typeof conversationId === 'string' && conversationId.length > 0 ? { conversation: conversationId } : {}
    const result = (await ctx.command('chat.history', args, { thread: st.viewThread })) as any
    if (loadingTimer !== null) clearTimeout(loadingTimer)
    if (disposedRef.current || seq !== requestSeq.current) return
    st.loading = false
    st.reloading = false
    st.loadingNote = false
    if (result === null || result.ok !== true) {
      st.error = {
        code: typeof result?.code === 'string' ? result.code : 'unknown',
        message: typeof result?.message === 'string' ? result.message : '',
      }
      rerender()
      return
    }
    const before = store.getSnapshot()
    const next = reconcilePendingUser(applySnapshot(before, result.value, conversationId))
    const base = initialWindow(next.messages.length)
    if (resetView) {
      st.window = base
    } else if (st.window.end < before.messages.length) {
      // 底部已被回收：保持裁剪，不因静默重拉把窗口拉回全量；内容收缩时收敛窗口避免切空。
      st.window = clampWindow(st.window, next.messages.length)
    } else {
      st.window = { start: Math.min(st.window.start, base.start), end: next.messages.length }
    }
    if (resetView) {
      st.group.unreadIds = new Set()
    }
    // 乐观用户气泡由 store 收口（权威快照已含同文用户消息即清除），不随整屏重置误清。
    st.finalizeAnnounce = options.announceFinal === true
    store.commit(next, { type: 'snapshot' })
    rerender()
    if (resetView) scrollToBottom()
    // 首屏 / 重拉后补渲染在途用户消息：run 暂停在审批 / 提问时槽仍留 `chat.message`、
    // 而权威历史尚未提交该消息，只靠回合开始事件拉会漏——重载后整条用户消息就「记录全没」。
    void loadPendingUser()
    // question 卡以服务端队列为准对账：已答 / 过期 ⇒ 只读并回填用户回答（part 快照只代表入队那一刻）。
    void reconcileQuestions(st.viewThread)
  }

  /** 重拉历史后按 `question.state` 对账 question 卡；失败（question 未就绪）静默回落快照，不阻断渲染。 */
  async function reconcileQuestions(thread: any): Promise<void> {
    if (collectQuestionItemIds(store.getSnapshot().messages).length === 0) return
    const result = (await ctx.command('question.state', null, { thread })) as any
    if (disposedRef.current || stateRef.current.viewThread !== thread) return
    const items = result !== null && result.ok === true && Array.isArray(result.value?.items) ? result.value.items : null
    if (items === null) return
    const byId: any = {}
    for (const item of items) {
      if (item !== null && typeof item === 'object' && typeof item.id === 'string') byId[item.id] = item
    }
    const patched = applyQuestionStates(store.getSnapshot(), byId)
    if (patched !== store.getSnapshot()) {
      store.commit(patched, { type: 'lifecycle' })
      rerender()
    }
  }

  // 稳定引用：这些 handler 进 `ChatCtx`，若每次渲染换新会随 `env` 一起改变 context 值，
  // 使全部 `useChatEnv` 消费者（含窗口内每条消息）在流式每帧重渲染。依赖只用 ref / 稳定回调。
  const submitQuestion = useCallback(
    async (vm: any, answers: any[]): Promise<{ ok: boolean; code?: string }> => {
      if (vm.itemId === null) return { ok: false, code: 'bad_args' }
      const thread = stateRef.current.viewThread
      // 输入槽已出世界：写走 input 服务命令（服务写自有存储），不再提交世界 directive。
      const command = slotWriteCommand(thread ?? '_main', { kind: 'question.answer', id: vm.itemId, answers })
      const wrote = (await ctx.command(command.name, command.args, { thread })) as any
      if (wrote === null || wrote.ok !== true) return { ok: false, code: wrote?.code ?? 'ui_unreachable' }
      const answered = (await ctx.command('question.answer', null, { thread })) as any
      if (answered === null || answered.ok !== true) return { ok: false, code: answered?.code ?? 'unknown' }
      return { ok: true }
    },
    [ctx],
  )

  const copyText = useCallback(
    async (def: any): Promise<{ ok: boolean }> => {
      const text = messageText(def)
      try {
        if (navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
          throw new Error('clipboard unavailable')
        }
        await navigator.clipboard.writeText(text)
        announce(lookupMessage(stateRef.current.table, 'chat_copied').body)
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
    [announce],
  )

  /**
   * 代码块复制按钮（markdown 字符串产物里的 `<button class="chat-codeblock-copy">`）：
   * 点击就近取 `.chat-codeblock pre code` 文本写入剪贴板，就地翻 `data-copy` 状态做反馈，
   * COPY_HOLD_MS 后回退；流式重渲染可能已替换节点，回退前判 `isConnected`。
   */
  const copyTimers = useRef<Map<HTMLButtonElement, ReturnType<typeof setTimeout>>>(new Map())
  async function copyCodeBlock(button: HTMLButtonElement): Promise<void> {
    const block = button.closest('.chat-codeblock')
    const code = block !== null ? block.querySelector('pre code') : null
    const text = code !== null ? code.textContent ?? '' : ''
    const set = (status: 'check' | 'error' | 'idle') => {
      if (button.isConnected) button.setAttribute('data-copy', status)
    }
    const prev = copyTimers.current.get(button)
    if (prev !== undefined) {
      clearTimeout(prev)
      copyTimers.current.delete(button)
    }
    try {
      if (navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable')
      }
      await navigator.clipboard.writeText(text)
      set('check')
      announce(lookupMessage(stateRef.current.table, 'chat_copied').body)
    } catch {
      set('error')
    }
    const timer = setTimeout(() => {
      copyTimers.current.delete(button)
      set('idle')
    }, COPY_HOLD_MS)
    ;(timer as { unref?: () => void }).unref?.()
    copyTimers.current.set(button, timer)
  }

  /**
   * 表格复制（markdown 产物里的 `<button class="chat-table-copy">`）：双路剪贴板——
   * `text/html` 让 Word / Notion / Docs 粘成真表格，`text/plain`=TSV 让 Excel / Sheets 自动分列；
   * 不支持 ClipboardItem 时退化为纯 TSV 文本。反馈与代码块复制同一套 data-copy 状态机。
   */
  async function copyTableBlock(button: HTMLButtonElement): Promise<void> {
    const block = button.closest('.chat-tableblock')
    const table = block !== null ? block.querySelector('table') : null
    if (table === null) return
    const rows = tableMatrix(table)
    const set = (status: 'check' | 'error' | 'idle') => {
      if (button.isConnected) button.setAttribute('data-copy', status)
    }
    const prev = copyTimers.current.get(button)
    if (prev !== undefined) {
      clearTimeout(prev)
      copyTimers.current.delete(button)
    }
    try {
      const clipboard = navigator.clipboard
      let written = false
      if (clipboard !== undefined && typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
        try {
          await clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([table.outerHTML], { type: 'text/html' }),
              'text/plain': new Blob([tableToTsv(rows)], { type: 'text/plain' }),
            }),
          ])
          written = true
        } catch {
          written = false
        }
      }
      if (!written) {
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          throw new Error('clipboard unavailable')
        }
        await clipboard.writeText(tableToTsv(rows))
      }
      set('check')
      announce(lookupMessage(stateRef.current.table, 'chat_copied').body)
    } catch {
      set('error')
    }
    const timer = setTimeout(() => {
      copyTimers.current.delete(button)
      set('idle')
    }, COPY_HOLD_MS)
    ;(timer as { unref?: () => void }).unref?.()
    copyTimers.current.set(button, timer)
  }

  /** 表格导出：CSV（UTF-8 BOM 防 Excel 乱码）或 GFM Markdown，均走浏览器下载。 */
  function exportTableBlock(block: Element, format: 'csv' | 'md'): void {
    const table = block.querySelector('table')
    if (table === null) return
    const rows = tableMatrix(table)
    if (format === 'csv') {
      downloadText('table.csv', '\uFEFF' + tableToCsv(rows), 'text/csv;charset=utf-8')
    } else {
      downloadText('table.md', tableToMarkdown(rows) + '\n', 'text/markdown;charset=utf-8')
    }
    announce(lookupMessage(stateRef.current.table, 'chat_exported').body)
  }

  const retryTurn = useCallback((): void => {
    void (async () => {
      const result = (await ctx.command('chat.send', null, { thread: stateRef.current.viewThread })) as any
      if (result === null || result.ok !== true) {
        stateRef.current.error = { code: typeof result?.code === 'string' ? result.code : 'unknown' }
        rerender()
      }
    })()
  }, [ctx, rerender])

  /** 从 `chat.message` 槽乐观渲染用户消息：发送落账（槽写入）/ 回合开始 / 重拉后各触发一次，快照收口。 */
  async function loadPendingUser(): Promise<void> {
    const thread = stateRef.current.viewThread
    const view = store.getSnapshot()
    if (view.kind === 'group') return
    const read = (await ctx.command('input.read', thread === null ? null : { thread }, { thread })) as any
    if (disposedRef.current || stateRef.current.viewThread !== thread) return
    const raw = read !== null && read.ok === true ? read.value : null
    const body = identityBodyOf(raw)
    const slots =
      body !== null && typeof body === 'object' && !Array.isArray(body) && body.slots !== null && typeof body.slots === 'object' && !Array.isArray(body.slots)
        ? body.slots
        : null
    const def = pendingUserDef(slots === null ? null : slots[thread ?? '_main'])
    if (def === null) return
    // 权威历史已含对应（同文 + 同附件数）用户消息（重拉 / 重复触发）则不乐观渲染，避免重复。
    if (hasPendingUserMessage(store.getSnapshot().messages, def)) return
    store.commit(setPendingUser(store.getSnapshot(), def), { type: 'lifecycle' })
  }

  const openLightbox = useCallback(
    (payload: { url: string; alt: string; thumb: HTMLElement | null }): void => {
      const machine = createLightboxState()
      machine.open(payload.url, payload.alt)
      stateRef.current.lightbox = { machine, url: payload.url, alt: payload.alt, thumb: payload.thumb, kind: 'image' }
      rerender()
    },
    [rerender],
  )

  const openVideo = useCallback(
    (url: string): void => {
      stateRef.current.lightbox = { machine: null, url, alt: '', thumb: null, kind: 'video' }
      rerender()
    },
    [rerender],
  )

  // 稳定引用：Lightbox 的键盘 / 滚动效果依赖 onClose，若每次渲染换新会反复退订重订。
  // 关闭先标记 closing 播退场动画，动画结束再卸载；期间重复点击不重入。
  const closeLightbox = useCallback((): void => {
    const lb = stateRef.current.lightbox
    if (lb === null || lb.closing === true) return
    lb.closing = true
    rerender()
    const thumb = lb.thumb
    window.setTimeout(() => {
      if (stateRef.current.lightbox !== lb) return
      stateRef.current.lightbox = null
      rerender()
      if (thumb !== null && typeof thumb.focus === 'function') thumb.focus()
    }, 160)
  }, [rerender])

  function loadOlder(): void {
    const st = stateRef.current
    const current = store.getSnapshot()
    if (st.windowBusy || !shouldWindow(current.messages.length) || !hasOlder(st.window)) return
    const el = scrollRef.current
    const prevHeight = el !== null ? el.scrollHeight : 0
    const prevTop = el !== null ? el.scrollTop : 0
    st.windowBusy = true
    st.window = olderWindow(st.window) ?? st.window
    pendingAdjust.current = { prevHeight, prevTop }
    pendingTrimBottom.current = true
    rerender()
    // windowBusy 在布局效果里复位：一帧只允许一次窗口操作。
  }

  function loadNewer(): void {
    const st = stateRef.current
    const total = store.getSnapshot().messages.length
    if (st.windowBusy || !shouldWindow(total)) return
    const next = newerWindow(st.window, total)
    if (next === null) return
    st.windowBusy = true
    st.window = next
    pendingTrimTop.current = true
    rerender()
  }

  /**
   * 滚动事件合帧：滚动事件一帧可触发多次，直接读 `scrollHeight` / `getBoundingClientRect`
   * 会反复强制同步布局。合成到每帧一次，最多一帧一次几何读取。
   */
  function onScroll(): void {
    if (scrollRaf.current !== 0) return
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      handleScroll()
    })
  }

  function handleScroll(): void {
    const el = scrollRef.current
    if (el === null) return
    const st = stateRef.current
    const nearWindowBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    // 到达窗口底部但仍有更新消息：向下扩窗（贴真实底部）。
    if (nearWindowBottom && st.window.end < store.getSnapshot().messages.length) loadNewer()
    // 只有窗口右端已到列表末端，才算「真·贴底」。
    const atBottom = nearWindowBottom && st.window.end >= store.getSnapshot().messages.length
    const changed = st.atBottom !== atBottom
    st.atBottom = atBottom
    if (atBottom) {
      if (st.newMsg.count !== 0) {
        st.newMsg = dismissNew()
        rerender()
      } else if (changed) {
        rerender()
      }
    } else if (changed) {
      rerender()
    }
    const anchor = st.group.anchorEl
    if (anchor !== null && anchor !== undefined) {
      // 以滚动容器自身为原点算锚点相对位置；滑过锚点 40px 隐藏，回到其上恢复。
      const relativeTop = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
      anchor.style.opacity = relativeTop < -40 ? '0' : '1'
    }
    if (el.scrollTop < 32) loadOlder()
  }

  function handleRecord(record: any): void {
    // 任何非增量事件先冲刷在途增量，保证「同连接内按到达顺序 fold」不被合帧打乱。
    flushDeltas()
    const st = stateRef.current
    const payload = record.payload !== null && typeof record.payload === 'object' ? record.payload : {}
    // 当前视图是否主会话：主会话视图下 `_main`（审批 / 提问续跑不带会话 id）也归本视图。
    const isMainView = store.getSnapshot().kind === 'main'
    const match = (thread: unknown): boolean => matchesThread(thread, st.viewThread, isMainView)
    if (record.topic === 'shell.state') {
      const wasConnected = st.connected
      st.connected = payload.connected === true
      if (!st.connected) {
        st.sawDisconnect = true
        return
      }
      if (!wasConnected) {
        if (st.sawDisconnect) {
          st.sawDisconnect = false
          store.commit(dropInFlight(clearPendingUser(store.getSnapshot())), { type: 'lifecycle' })
          void apiRef.current.loadHistory(st.viewThread, { resetView: false })
        } else if (st.error !== null && st.error.code === 'ui_unreachable') {
          void apiRef.current.loadHistory(st.viewThread)
        }
      }
      return
    }
    if (record.topic === 'model.delta') {
      if (match(payload.thread)) {
        pendingDeltas.current.push({ kind: 'delta', payload })
        scheduleFlush()
      }
      return
    }
    if (record.topic === 'tool.start') {
      if (match(payload.thread)) {
        store.commit(applyToolStart(store.getSnapshot(), payload), { type: 'lifecycle' })
      }
      return
    }
    if (record.topic === 'tool.delta') {
      if (match(payload.thread)) {
        pendingDeltas.current.push({ kind: 'tool', payload })
        scheduleFlush()
      }
      return
    }
    if (record.topic === 'tool.end') {
      if (match(payload.thread)) {
        store.commit(applyToolEnd(store.getSnapshot(), payload), { type: 'lifecycle' })
      }
      return
    }
    // 回合开始由 chat 服务自报（`chat.turn.started`）：续跑是嵌套 eval，没有宿主 run 生命周期，
    // 只看 `run.started.name` 会漏掉续跑、工作态在首个 delta 前空窗。
    if (record.topic === 'chat.turn.started') {
      if (match(payload.thread)) {
        store.commit(applyRunStarted(store.getSnapshot(), payload), { type: 'lifecycle' })
        void apiRef.current.loadPendingUser()
      }
      return
    }
    if (record.topic === 'chat.turn.pending') {
      // 回合挂起（等审批 / 等作答）：保留在途块并显示等待态，不当作定稿清空。
      if (match(payload.thread)) {
        store.commit(applyTurnPending(store.getSnapshot(), payload), { type: 'lifecycle' })
      }
      return
    }
    if (record.topic === 'chat.turn.settled') {
      // 回合终态：挂起期间到达的终局（尤其取消）也在此收口，并重拉权威历史。
      if (match(payload.thread)) {
        store.commit(applyTurnSettled(store.getSnapshot(), payload), { type: 'lifecycle' })
        void apiRef.current.loadHistory(st.viewThread, { resetView: false })
      }
      return
    }
    if (record.topic === 'run.finished') {
      if (isPeriodicRun(payload.origin)) return
      if (!match(payload.thread)) return
      // 输入槽写入落账（`input.write` 命令 run）：用户消息已持久，立即乐观渲染在途用户消息。
      // 不等回合开始事件——回合开始前还有 owner 读 / 标题生成等前段（首条消息尤甚），
      // 且快回合可能在客户端读到槽前就提交清槽；此处读槽才是「用户刚发送」的确定时刻。
      if (payload.name === 'input.write') {
        void apiRef.current.loadPendingUser()
        return
      }
      const folded = foldRunFinished(store.getSnapshot(), payload)
      if (folded.action === 'ignore') {
        // `chat.send` 命令 run 落账但从未开启回合（回合前拒绝 / 传输失败）：收起乐观用户气泡，
        // 免得一条从未成为回合的消息永久挂在消息流尾。
        if (payload.name === 'chat.send') {
          store.commit(clearPendingUser(store.getSnapshot()), { type: 'lifecycle' })
        }
        return
      }
      if (folded.action === 'suspend') {
        // 挂起段的宿主 run 结束但回合未完：保留在途块，等续跑 / 终局事件。
        store.commit(folded.view, { type: 'lifecycle' })
        return
      }
      // cancel：显式清乐观用户气泡；refused / interrupt / violation 同样落账，
      // 失败不得静默当成功——持久回合结局块在重拉后呈现。
      const next = folded.action === 'cancel' ? clearPendingUser(folded.view) : folded.view
      store.commit(next, { type: 'lifecycle' })
      void apiRef.current.loadHistory(st.viewThread, {
        resetView: false,
        announceFinal: folded.action === 'finalize',
      })
      return
    }
    if (record.topic === 'group.message') {
      if (!match(dataChangeTarget(payload))) return
      const id = typeof payload.id === 'string' ? payload.id : typeof payload.message === 'string' ? payload.message : ''
      if (id.length > 0) st.group.unreadIds.add(id)
      void apiRef.current.loadHistory(st.viewThread, { resetView: false })
      return
    }
    if (record.topic === 'thread.updated' || record.topic === 'thread.opened' || record.topic === 'thread.closed') {
      if (!match(dataChangeTarget(payload))) return
      void apiRef.current.loadHistory(st.viewThread, { resetView: false })
    }
  }

  function onThreadChange(value: any): void {
    // 切线程前先落地在途增量，避免旧线程已收增量丢失或跨线程错配。
    flushDeltas()
    const st = stateRef.current
    st.viewThread = typeof value === 'string' && value.length > 0 ? value : null
    store.commit(dropInFlight(clearPendingUser(store.getSnapshot())), { type: 'lifecycle' })
    st.listOpacity = 0
    rerender()
    const target = st.viewThread
    const pending = apiRef.current.loadHistory(target)
    const seq = requestSeq.current
    void pending.then(() => {
      // 仅当仍是最新一次请求且线程未再切换时恢复不透明，避免旧回包提前显影。
      if (seq !== requestSeq.current || stateRef.current.viewThread !== target) return
      stateRef.current.listOpacity = 1
      rerender()
    })
  }

  // 每次渲染刷新给事件处理器用的函数表（事件处理器只订阅一次，避免反复退订）；改 ref 走 effect。
  useEffect(() => {
    apiRef.current.loadHistory = loadHistory
    apiRef.current.handleRecord = handleRecord
    apiRef.current.onThreadChange = onThreadChange
    apiRef.current.loadPendingUser = loadPendingUser
  })

  // 首屏：拉文案表 → 订阅事件与线程 → 首次快照。
  useEffect(() => {
    let alive = true
    let offEvents: (() => void) | null = null
    let offThread: (() => void) | null = null
    void (async () => {
      const table = await loadMessages((url) => fetch(url), ctx.tokens.messages)
      if (!alive) return
      stateRef.current.table = table
      rerender()
      if (typeof ctx.events?.onAny === 'function') {
        offEvents = ctx.events.onAny((record) => apiRef.current.handleRecord(record))
      }
      if (typeof ctx.uiState?.subscribe === 'function') {
        offThread = ctx.uiState.subscribe('active_thread', (value) => apiRef.current.onThreadChange(value))
      }
      stateRef.current.connected = typeof ctx.events?.connected === 'function' ? ctx.events.connected() : false
      const initial = typeof ctx.uiState?.get === 'function' ? ctx.uiState.get('active_thread') : undefined
      stateRef.current.viewThread = typeof initial === 'string' && initial.length > 0 ? initial : null
      await apiRef.current.loadHistory(stateRef.current.viewThread)
    })()
    return () => {
      alive = false
      disposedRef.current = true
      if (offEvents !== null) offEvents()
      if (offThread !== null) offThread()
      if (announceTimer.current !== null) clearTimeout(announceTimer.current)
      if (scrollRaf.current !== 0) cancelAnimationFrame(scrollRaf.current)
    }
  }, [])

  // 内容增长：贴底自动贴底；上滑冻结才出胶囊。
  useLayoutEffect(() => {
    const st = stateRef.current
    const key = contentKey(view, view.pendingUser !== null)
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key
      if (st.atBottom) {
        pinToBottom(scrollRef.current)
        if (st.newMsg.count !== 0) {
          st.newMsg = dismissNew()
          rerender()
        }
      } else {
        st.newMsg = onNewContent(st.newMsg, false)
        rerender()
      }
    }
  }, [view, rerender])

  // 窗口滚动后的位置补偿与远端回收：每帧只做一种单方向 DOM 变更，高度差补偿才准确。
  useLayoutEffect(() => {
    const st = stateRef.current
    const el = scrollRef.current
    const adjust = pendingAdjust.current
    if (adjust !== null) {
      pendingAdjust.current = null
      if (el !== null) el.scrollTop = el.scrollHeight - adjust.prevHeight + adjust.prevTop
    }
    if (pendingTrimTop.current) {
      pendingTrimTop.current = false
      const prevHeight = el !== null ? el.scrollHeight : 0
      const prevTop = el !== null ? el.scrollTop : 0
      const trimmed = trimTop(st.window)
      if (trimmed.removed > 0) {
        st.window = trimmed.state
        pendingAdjust.current = { prevHeight, prevTop }
        rerender()
        return
      }
    } else if (pendingTrimBottom.current) {
      pendingTrimBottom.current = false
      const trimmed = trimBottom(st.window)
      if (trimmed.removed > 0) {
        st.window = trimmed.state
        rerender()
        return
      }
    }
    if (pendingScrollBottom.current) {
      pendingScrollBottom.current = false
      scrollToBottom()
    }
    st.windowBusy = false
  })

  // 定稿播报：一次性 aria-live，渲染后复位（复位需重渲染才能真正摘除属性）。
  useEffect(() => {
    if (stateRef.current.finalizeAnnounce) {
      stateRef.current.finalizeAnnounce = false
      rerender()
    }
  }, [view, rerender])

  const st = stateRef.current
  const table = st.table

  // 稳定 context 值：字段全为稳定引用（ctx / 文案表 / useCallback）时引用跨帧不变，
  // 流式增量提交只重渲染真正读 view 的子树（StreamTurn），不再扇出到窗口内每条消息。
  const env: ChatEnv = useMemo(
    () => ({
      ctx,
      table,
      announce,
      openLightbox,
      openVideo,
      submitQuestion,
      copyText,
      retry: retryTurn,
    }),
    [ctx, table, announce, openLightbox, openVideo, submitQuestion, copyText, retryTurn],
  )

  function renderConversation(): ReactNode {
    const nodes: ReactNode[] = []
    if (view.kind === 'subagent') {
      const conversation = view.conversation
      const refs = view.refs
      const agentDef =
        conversation !== null && conversation.agent !== undefined && conversation.agent !== null
          ? conversation.agent.def
          : null
      const agentName =
        typeof agentDef === 'string' &&
        typeof refs[agentDef] === 'object' &&
        refs[agentDef] !== null &&
        typeof refs[agentDef].name === 'string'
          ? refs[agentDef].name
          : lookupMessage(table, 'chat_subagent').body
      const parentDef =
        conversation !== null && conversation.parent !== undefined && conversation.parent !== null
          ? conversation.parent.def
          : null
      let parentName = ''
      if (typeof parentDef === 'string') {
        const parent = view.conversations.find((item: any) => item.id === parentDef)
        parentName = parent !== undefined && typeof parent.title === 'string' ? parent.title : parentDef
      }
      nodes.push(
        <div key="subagent" className="chat-subagent-head">
          {subagentHeader(agentName, parentName)}
        </div>,
      )
    }
    if (view.messages.length === 0 && view.inFlight === null && view.pendingUser === null) {
      nodes.push(
        <div key="empty" className="chat-empty">
          <img className="chat-empty-logo" src="/favicon.svg" alt="" aria-hidden="true" />
          <div className="chat-empty-title">{lookupMessage(table, 'chat_empty_title').body}</div>
          <div className="chat-empty-hint">{lookupMessage(table, 'chat_empty_hint').body}</div>
        </div>,
      )
      return nodes
    }
    const windowed = shouldWindow(view.messages.length)
    if (windowed) {
      nodes.push(
        hasOlder(st.window) ? (
          <div key="older" className="chat-top-notice">
            <div className="chat-breathe chat-breathe-inline" />
          </div>
        ) : (
          <div key="nomore" className="chat-date">
            {lookupMessage(table, 'chat_no_more').body}
          </div>
        ),
      )
    }
    const inFlightTurnId =
      view.inFlight !== null && typeof view.inFlight.turnId === 'string' ? view.inFlight.turnId : null
    nodes.push(
      <HistoryList
        key="history"
        messages={view.messages}
        start={st.window.start}
        end={st.window.end}
        inFlightTurnId={inFlightTurnId}
        finalizeAnnounce={st.finalizeAnnounce}
        revision={view.revision}
      />,
    )
    // 在途用户消息（乐观）：发送落账即渲染（不等回合开始），权威快照落地即收起。
    if (view.pendingUser !== null) {
      nodes.push(
        <MessageBoundary key="pending-user" resetKey={`pending:${view.revision}`} fallback={<RenderFallback />}>
          <MessageItem entry={{ def: view.pendingUser }} announce={false} />
        </MessageBoundary>,
      )
    }
    if (view.inFlight !== null) {
      nodes.push(
        <MessageBoundary key="stream" resetKey={`stream:${view.revision}`} fallback={<RenderFallback />}>
          <StreamTurn view={view} />
        </MessageBoundary>,
      )
    }
    // 持久回合结局块：已收口且非 committed 的回合按结局渲染（失败 / 取消 / 中断不消失）。
    for (const block of outcomeBlocks(view)) {
      nodes.push(
        <MessageBoundary
          key={`outcome-${block.turnId ?? 'unknown'}`}
          resetKey={`outcome:${view.revision}`}
          fallback={<RenderFallback />}
        >
          <TurnOutcomeLine outcome={block.outcome} />
        </MessageBoundary>,
      )
    }
    return nodes
  }

  function renderGroup(): ReactNode {
    const vm = groupViewModel({
      conversation: view.conversation,
      messages: view.messages,
      refs: view.refs,
      streaming: isStreaming(view),
      unreadIds: st.group.unreadIds,
    })
    return vm.items.map((item: any, index: number) => (
      <Fragment key={item.id || index}>
        {index === vm.anchorIndex && vm.anchorIndex >= 0 ? (
          <div
            className="chat-anchor"
            ref={(node) => {
              st.group.anchorEl = node
            }}
          >
            {lookupMessage(table, 'chat_new_messages').body}
          </div>
        ) : null}
        {item.isMe ? (
          <div className="chat-msg chat-msg-user">
            <div className="chat-bubble-user">
              {item.items.length === 0 ? item.text : null}
              {item.items.map((vm: any, index: number) =>
                vm.type === 'text' ? <div key={index}>{vm.text}</div> : <RenderItem key={index} vm={vm} />,
              )}
            </div>
          </div>
        ) : (
          <div className="chat-group-item">
            <div className="chat-group-avatar" data-current={String(item.current)}>
              {item.initial}
            </div>
            <div className="chat-group-body">
              {item.showName ? <div className="chat-group-name">{item.speakerName}</div> : null}
              <div className="chat-group-bubble">
                <MessageBoundary resetKey={`group:${view.revision}`} fallback={<RenderFallback />}>
                  <GroupItemBody item={item} />
                </MessageBoundary>
              </div>
            </div>
          </div>
        )}
      </Fragment>
    ))
  }

  function renderList(): ReactNode {
    const errorBar =
      st.error !== null ? (
        <ErrorBar error={st.error} onRetry={() => void loadHistory(st.viewThread)} />
      ) : null
    // 已有内容时，历史重拉失败只提示、不清空会话：瞬时超时不应抹掉已渲染消息。
    // 乐观用户气泡也算内容：槽已写入时首屏加载中 / 历史失败都不该把它藏掉。
    const hasContent = store.getSnapshot().messages.length > 0 || view.pendingUser !== null
    if (errorBar !== null && !hasContent) return errorBar
    if (st.loading && !hasContent) {
      return (
        <div className="chat-block-loading">
          <div className="chat-breathe" />
          {st.loadingNote ? <div className="chat-workflow-meta">{lookupMessage(table, 'chat_loading').body}</div> : null}
        </div>
      )
    }
    const body = view.kind === 'group' ? renderGroup() : renderConversation()
    return errorBar === null ? body : (
      <>
        {errorBar}
        {body}
      </>
    )
  }

  const pillText = st.newMsg.count > 0 ? pillLabel(st.newMsg.count) : lookupMessage(table, 'chat_pill_more').body

  return (
    <ChatCtx.Provider value={env}>
      <style>{STYLE_TEXT}</style>
      <div className="chat-root">
        <div className="chat-status" hidden={!st.loading && !st.reloading}>
          <div className="chat-breathe" />
        </div>
        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={onScroll}
          onClick={(event) => {
            const target = event.target as HTMLElement
            const scroll = event.currentTarget
            // 表格导出菜单：点菜单外任何处先收起；点自己按钮则就地开合。
            const exportBtn = target !== null ? (target.closest('.chat-table-export') as HTMLButtonElement | null) : null
            const menuItem = target !== null ? (target.closest('.chat-table-menu button') as HTMLButtonElement | null) : null
            if (exportBtn === null && menuItem === null) closeTableMenus(scroll)
            if (menuItem !== null) {
              event.preventDefault()
              const block = menuItem.closest('.chat-tableblock')
              if (block !== null) exportTableBlock(block, menuItem.classList.contains('chat-table-export-md') ? 'md' : 'csv')
              closeTableMenus(scroll)
              return
            }
            if (exportBtn !== null) {
              event.preventDefault()
              const block = exportBtn.closest('.chat-tableblock')
              if (block !== null) {
                closeTableMenus(scroll, block)
                const open = block.classList.toggle('chat-menu-open')
                exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
              }
              return
            }
            // 表格复制：双路剪贴板（HTML + TSV）。
            const tableCopyBtn = target !== null ? (target.closest('.chat-table-copy') as HTMLButtonElement | null) : null
            if (tableCopyBtn !== null) {
              event.preventDefault()
              void copyTableBlock(tableCopyBtn)
              return
            }
            // 代码块展开 / 收起：翻转外壳 data-collapsed，同步按钮文案与 aria。
            const toggleBtn = target !== null ? (target.closest('.chat-codeblock-toggle') as HTMLButtonElement | null) : null
            if (toggleBtn !== null) {
              event.preventDefault()
              const block = toggleBtn.closest('.chat-codeblock')
              if (block !== null) {
                const collapsed = block.getAttribute('data-collapsed') === 'true'
                block.setAttribute('data-collapsed', collapsed ? 'false' : 'true')
                syncCodeToggle(toggleBtn, !collapsed, stateRef.current.table)
              }
              return
            }
            // 代码块复制按钮：就近取代码文本写入剪贴板（markdown 字符串产物，无 React 状态）。
            const copyBtn = target !== null ? (target.closest('.chat-codeblock-copy') as HTMLButtonElement | null) : null
            if (copyBtn !== null) {
              event.preventDefault()
              void copyCodeBlock(copyBtn)
              return
            }
            // 只处理 markdown 正文里的图片；空态 logo 等非正文图片不弹灯箱。
            if (target !== null && target.tagName === 'IMG' && target.closest('.chat-md') !== null) {
              const src = target.getAttribute('src')
              if (src !== null && src.length > 0) {
                openLightbox({ url: src, alt: target.getAttribute('alt') ?? '', thumb: target })
              }
            }
          }}
        >
          <div className="chat-list" style={{ opacity: st.listOpacity }}>
            {renderList()}
          </div>
        </div>
        <button
          type="button"
          className="chat-pill"
          hidden={st.atBottom}
          aria-live="polite"
          aria-atomic="true"
          onClick={() => {
            // 先恢复到最新一窗，再在渲染后贴底（窗口可能此前被远端回收）。
            stateRef.current.window = initialWindow(store.getSnapshot().messages.length)
            stateRef.current.atBottom = true
            stateRef.current.newMsg = dismissNew()
            pendingScrollBottom.current = true
            rerender()
          }}
        >
          {pillText}
        </button>
        <div className="chat-sr" aria-live="polite" aria-atomic="true">
          {liveText}
        </div>
        {st.lightbox !== null ? <Lightbox lb={st.lightbox} onClose={closeLightbox} /> : null}
      </div>
    </ChatCtx.Provider>
  )
}

export function register(ctx: SlotContext): void {
  // store 住 register 作用域：壳错误边界卸载后重挂复用同一实例，消息 / 在途流 / 定稿记忆不随组件销毁。
  const store = createThreadStore(emptyView())
  ctx.slots.register({ name: 'main' }, (props) => <App ctx={props.ctx} store={store} />)
}
