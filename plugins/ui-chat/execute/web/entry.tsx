// `ui-chat` 客户端半边（slot = main）：React 组件 + React-free store 绑定。
// 契约：`export const contract = '2'` + `register(ctx)` 把 App 注册进 main slot。
// 业务状态住 `thread-store`（快照 + 有序增量 + 定稿替换）；组件只渲染纯模块产出的视图模型。
// markdown 正文统一经 `Markdown`（全仓唯一 `dangerouslySetInnerHTML` 处）；流式与定稿同一管线。

import {
  Component,
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { SlotContext } from '@chrono/ui-contract'

import { STYLE_TEXT } from './styles.ts'
import { createMarkdownCache, renderMarkdownIncremental } from './markdown-cache.ts'
import type { MarkdownCache } from './markdown-cache.ts'
import { base64ToBytes, fitBox } from './media.ts'
import { FALLBACK_MESSAGES, formatText, loadMessages, lookupMessage } from './messages.ts'
import type { MessageTable } from './messages.ts'
import {
  dataChangeTarget,
  hasUserMessage,
  isPeriodicRun,
  matchesThread,
  messageId,
  messageText,
} from './history-model.ts'
import {
  applyDelta,
  applyRunStarted,
  applySnapshot,
  applyToolDelta,
  applyToolEnd,
  applyToolStart,
  createThreadStore,
  dropInFlight,
  emptyView,
  foldRunFinished,
  isStreaming,
} from './thread-store.ts'
import { messageViewItems, partViewModel, pendingUserDef, safeStringify } from './render-parts.ts'
import { toolCardViewModel } from './tool-card.ts'
import { detailViewModel } from './detail-renderers.ts'
import { buildDateSeparators } from './date-sep.ts'
import { usageText } from './usage.ts'
import { COPY_HOLD_MS } from './copy.ts'
import { createLightboxState } from './lightbox.ts'
import { groupViewModel } from './group.ts'
import { statusIcon, statusText, workflowViewModel } from './workflow.ts'
import {
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
}

/** 单条消息的渲染异常边界：异常在本条内收束为降级提示，不冒泡崩掉整棵聊天树。 */
class MessageBoundary extends Component<BoundaryProps, { failed: boolean }> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError(): { failed: boolean } {
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

/**
 * 全仓唯一 `dangerouslySetInnerHTML` 处：markdown 渲染 + 白名单消毒。
 * 经增量缓存（`renderMarkdownIncremental`）——流式时已完成前缀只解析一次，只重解析尾部块。
 */
function Markdown({ text, className }: { text: unknown; className?: string }): ReactNode {
  const cacheRef = useRef<MarkdownCache | null>(null)
  if (cacheRef.current === null) cacheRef.current = createMarkdownCache()
  const html = useMemo(() => {
    const result = renderMarkdownIncremental(text, cacheRef.current as MarkdownCache)
    cacheRef.current = result.cache
    return result.html
  }, [text])
  return <div className={className ?? 'chat-md'} dangerouslySetInnerHTML={{ __html: html }} />
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
  const url = useAssetUrl(source, 0)
  if (url === null) return <MediaPlaceholder onRetry={() => {}} />
  return (
    <div className="chat-video-thumb">
      <video className="chat-media-video" src={url} preload="metadata" muted />
      <button type="button" className="chat-video-play" onClick={() => env.openVideo(url)}>
        {lookupMessage(env.table, 'chat_play_video').body}
      </button>
    </div>
  )
}

function MediaAudio({ source }: { source: any }): ReactNode {
  const url = useAssetUrl(source, 0)
  if (url === null) return <MediaPlaceholder onRetry={() => {}} />
  return <audio className="chat-media-audio" src={url} controls preload="none" />
}

function FileCard({ name, source }: { name: string; source: any }): ReactNode {
  const url = useAssetUrl(source, 0)
  const inner = (
    <>
      <Icon name="paperclip" size={16} />
      <span className="chat-file-name">{name}</span>
    </>
  )
  if (url === null) return <div className="chat-file">{inner}</div>
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
  if (vm.exitCode !== null) children.push(<div key="exit" className="chat-terminal-exit">{`退出码 ${vm.exitCode}`}</div>)
  if (children.length === 0) children.push(<div key="breathe" className="chat-breathe" />)
  return <div className="chat-terminal">{children}</div>
}

function DiffView({ vm }: { vm: any }): ReactNode {
  return (
    <div className="chat-diff">
      {vm.rows.map((row: any, index: number) => {
        if (row.type === 'hunk') {
          return <div key={index} className="chat-diff-row chat-diff-hunk">{row.text ?? `… 折叠 ${row.count} 行 …`}</div>
        }
        if (row.type === 'mod') {
          return <div key={index} className="chat-diff-row chat-diff-mod">{`~ ${row.before} → ${row.after}`}</div>
        }
        if (row.type === 'add') return <div key={index} className="chat-diff-row chat-diff-add">{`+ ${row.text}`}</div>
        if (row.type === 'del') return <div key={index} className="chat-diff-row chat-diff-del">{`- ${row.text}`}</div>
        return <div key={index} className="chat-diff-row chat-diff-ctx">{`  ${row.text}`}</div>
      })}
    </div>
  )
}

/** question 交互卡：单选 / 多选 / 自定义输入 / 提交；已答折叠；expired 禁用。 */
function QuestionCard({ vm }: { vm: any }): ReactNode {
  const env = useChatEnv()
  // answered / answers 从 vm 派生，本地提交只作覆盖层：快照回流（他处作答 / 重拉）不再脱节。
  const [localAnswers, setLocalAnswers] = useState<any[] | null>(null)
  const answered = vm.answered === true || localAnswers !== null
  const answers = localAnswers !== null ? localAnswers : vm.answers
  const [selections, setSelections] = useState<{ [id: string]: string[] }>(() => {
    const init: { [id: string]: string[] } = {}
    for (const question of vm.questions) init[question.id] = []
    return init
  })
  const [customs, setCustoms] = useState<{ [id: string]: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (answered) {
    return (
      <div className="chat-question">
        {vm.questions.map((question: any) => {
          const answer = answers.find((item: any) => item.questionId === question.id)
          const parts: string[] = []
          if (answer !== undefined) parts.push(...answer.selected)
          if (answer !== undefined && answer.custom !== null && answer.custom.length > 0) parts.push(answer.custom)
          return (
            <div key={question.id}>
              <div className="chat-question-q">{question.header || question.question}</div>
              <div className="chat-muted">{parts.join('、')}</div>
            </div>
          )
        })}
      </div>
    )
  }

  const toggle = (question: any, label: string) => {
    if (vm.expired) return
    setSelections((current) => {
      const next: { [id: string]: string[] } = {}
      for (const key of Object.keys(current)) next[key] = [...current[key]]
      const set = new Set(next[question.id] ?? [])
      if (question.multiple) {
        if (set.has(label)) set.delete(label)
        else set.add(label)
      } else {
        set.clear()
        set.add(label)
      }
      next[question.id] = [...set]
      return next
    })
  }

  const submit = async () => {
    if (vm.expired || submitting) return
    const collected: any[] = []
    for (const question of vm.questions) {
      const selected = selections[question.id] ?? []
      const custom = (customs[question.id] ?? '').trim()
      if (selected.length === 0 && custom.length === 0) continue
      const answer: any = { question_id: question.id, selected }
      if (custom.length > 0) answer.custom = custom
      collected.push(answer)
    }
    if (collected.length === 0) {
      setError(lookupMessage(env.table, 'chat_answer_required').body)
      return
    }
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
    setSubmitting(false)
    setError(lookupMessage(env.table, result.code ?? 'unknown').body)
  }

  return (
    <div className="chat-question" data-expired={String(vm.expired)}>
      {vm.expired ? (
        <div className="chat-warning-inline">
          <Icon name="alert-triangle" size={16} />
          <span>{lookupMessage(env.table, 'chat_expired').body}</span>
        </div>
      ) : null}
      {vm.questions.map((question: any) => (
        <div
          key={question.id}
          className="chat-question-group"
          role={question.multiple ? 'group' : 'radiogroup'}
          aria-label={question.header || question.question}
        >
          {question.header.length > 0 ? <div className="chat-question-q">{question.header}</div> : null}
          <div>{question.question}</div>
          {question.options.map((option: any) => {
            const checked = (selections[question.id] ?? []).includes(option.label)
            return (
              <div
                key={option.label}
                className="chat-question-opt"
                role={question.multiple ? 'checkbox' : 'radio'}
                tabIndex={vm.expired ? -1 : 0}
                aria-checked={checked}
                aria-disabled={vm.expired}
                onClick={() => toggle(question, option.label)}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Spacebar') {
                    event.preventDefault()
                    toggle(question, option.label)
                  } else if (event.key === 'Enter') {
                    event.preventDefault()
                    void submit()
                  }
                }}
              >
                <span>{option.label}</span>
                {option.description.length > 0 ? (
                  <span className="chat-question-opt-desc">{option.description}</span>
                ) : null}
              </div>
            )
          })}
          {question.custom ? (
            <input
              className="chat-question-input"
              type="text"
              placeholder={lookupMessage(env.table, 'chat_custom_input').body}
              aria-label={`${lookupMessage(env.table, 'chat_custom_answer').body}：${question.header || question.question}`}
              disabled={vm.expired}
              value={customs[question.id] ?? ''}
              onChange={(event) =>
                setCustoms((current) => ({ ...current, [question.id]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
          ) : null}
        </div>
      ))}
      <div className="chat-question-actions">
        <button
          type="button"
          className="chat-btn chat-btn-accent"
          disabled={vm.expired || submitting}
          onClick={() => void submit()}
        >
          {submitting ? lookupMessage(env.table, 'chat_submitting').body : lookupMessage(env.table, 'chat_submit').body}
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
            <div key={index}>
              <span className="chat-matches-line">{`${item.path}:${item.line}  `}</span>
              <span>{item.text}</span>
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
 * 推理折叠块：默认收起，头部给「推理」标签（流式中带呼吸点），展开为内嵌灰底 markdown。
 * 推理只作展示，不进模型上下文（由 context-window 丢弃）。
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const { table } = useChatEnv()
  const [open, setOpen] = useState(false)
  if (text.length === 0) return null
  return (
    <div className="chat-reasoning" data-open={String(open)}>
      <button
        type="button"
        className="chat-reasoning-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
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
      {open ? (
        <div className="chat-reasoning-body">
          <Markdown text={text} />
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
 * 在途卡（`live` 非空）结果尚未落地：展开体只给流式输出（`render.live`）或调用参数，
 * 不渲染空 detail；定稿卡展开体渲染描述符与结果合并后的 detail。
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
        : 'ok'
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
          ) : streaming ? (
            <pre className="chat-code-block">{safeStringify(vm.args ?? null)}</pre>
          ) : (
            <DetailView detail={vm.detail} />
          )}
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
  return (
    <>
      <IconButton
        name={state === 'check' ? 'check' : state === 'error' ? 'alert-circle' : 'copy'}
        label={lookupMessage(env.table, 'chat_copy').body}
        dataCopy={state}
        onClick={() => {
          void env.copyText(def).then((result) => {
            if (result.ok) {
              setState('check')
              timer.current = setTimeout(() => setState('idle'), COPY_HOLD_MS)
            } else {
              setState('error')
            }
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

/** 在途工具卡：结果尚未落地，展开体只给流式输出或调用参数。 */
function StreamToolCard({ tool }: { tool: any }): ReactNode {
  if (tool === null || tool === undefined) return null
  const vm = toolCardViewModel({
    type: 'tool',
    callId: tool.callId,
    tool: tool.tool,
    render: tool.render,
    args: tool.args,
    result: null,
    status: null,
  })
  return <ToolCard vm={vm} live={{ chunks: tool.chunks, done: tool.done === true, ok: tool.ok ?? null }} />
}

function StreamTurn({ view, slowStream }: { view: any; slowStream: boolean }): ReactNode {
  const env = useChatEnv()
  const inFlight = view.inFlight
  if (inFlight === null) return null
  const streaming = isStreaming(view)
  const hasOutput = inFlight.text.length > 0 || inFlight.reasoning.length > 0
  const activeTools = inFlight.tools.some((tool: any) => tool.done !== true)
  // 工具在跑时由卡片状态自证活动，不再叠「仍在生成」；有推理/正文即撤。
  const showNote = inFlight.cancelled === true || (!hasOutput && slowStream && !activeTools)
  const toolsById = new Map(inFlight.tools.map((tool: any) => [tool.callId, tool]))
  const lastIndex = inFlight.segments.length - 1
  return (
    <div className="chat-msg chat-msg-assistant" aria-busy={inFlight.cancelled === true ? undefined : true}>
      {inFlight.segments.length === 0 ? <div className="chat-breathe" /> : null}
      {inFlight.segments.map((segment: any, index: number) => {
        if (segment.kind === 'reasoning') {
          return (
            <ReasoningBlock key={`reasoning-${index}`} text={segment.text} streaming={streaming && index === lastIndex} />
          )
        }
        if (segment.kind === 'text') {
          return (
            <div key={`text-${index}`} className="chat-stream-text-wrap">
              <Markdown text={segment.text} className="chat-md chat-stream-text" />
              {streaming && index === lastIndex ? <span className="chat-cursor" /> : null}
            </div>
          )
        }
        return <StreamToolCard key={segment.callId} tool={toolsById.get(segment.callId)} />
      })}
      {showNote ? (
        <div className="chat-workflow-meta">
          {inFlight.cancelled === true
            ? lookupMessage(env.table, 'chat_cancelled').body
            : lookupMessage(env.table, 'chat_generating').body}
        </div>
      ) : null}
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
  const def = item.def
  const parts = Array.isArray(def?.parts) && def.parts.length > 0 ? def.parts : null
  if (parts === null) return <Markdown text={item.text} />
  return (
    <>
      {parts.map((part: any, index: number) => (
        <RenderItem key={index} vm={partViewModelSafe(part)} />
      ))}
    </>
  )
}

function partViewModelSafe(part: any): any {
  // 群聊 part 与消息 parts 同形，复用 RenderItem 的视图模型口径。
  return partViewModel(part)
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

/** 构造写输入槽的 batch directive：只覆盖本线程键（读-改-写）。 */
function slotWriteDirective(slots: any, threadKey: string, slot: any): any {
  const nextSlots = { ...(slots ?? {}), [threadKey]: slot }
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body: { slots: nextSlots } } },
          { op: 'add_gen', args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
        ],
      },
    },
  }
}

function isAssistantEntry(entry: any): boolean {
  const def = entry !== null && typeof entry === 'object' ? entry.def : null
  const role = def !== null && typeof def.role === 'string' ? def.role : 'assistant'
  return role !== 'user' && role !== 'system'
}

function contentKey(view: any): string {
  const inFlight = view.inFlight
  const textLength = inFlight !== null ? inFlight.text.length : -1
  const reasoningLength = inFlight !== null ? inFlight.reasoning.length : -1
  const chunkLength =
    inFlight !== null
      ? inFlight.tools.reduce((total: number, tool: any) => total + (tool.chunks ? tool.chunks.length : 0), 0)
      : -1
  const toolCount = inFlight !== null ? inFlight.tools.length : -1
  const doneCount = inFlight !== null ? inFlight.tools.filter((tool: any) => tool.done === true).length : -1
  return `${view.messages.length}|${textLength}|${reasoningLength}|${chunkLength}|${toolCount}|${doneCount}`
}

function App({ ctx }: { ctx: SlotContext }): ReactNode {
  const storeRef = useRef<ReturnType<typeof createThreadStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createThreadStore(emptyView())
  const store = storeRef.current
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
    workflowStep: null,
    pendingUser: null,
    connected: false,
    sawDisconnect: false,
    slowStream: false,
    table: FALLBACK_MESSAGES as MessageTable,
    lightbox: null,
    listOpacity: 1,
  })
  const [, setTick] = useState(0)
  const rerender = useCallback(() => setTick((value) => value + 1), [])
  // 流式增量合帧：同一帧内到达的 model.delta 合并为一次 store 提交（一帧最多一次重渲染）。
  const pendingDeltas = useRef<any[]>([])
  const flushScheduled = useRef(false)
  const flushDeltas = useCallback(() => {
    if (pendingDeltas.current.length === 0) return
    const queued = pendingDeltas.current
    pendingDeltas.current = []
    let next = store.getSnapshot()
    for (const payload of queued) next = applyDelta(next, payload)
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
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
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
    const next = applySnapshot(before, result.value, conversationId)
    const base = initialWindow(next.messages.length)
    if (resetView) {
      st.window = base
    } else if (st.window.end < before.messages.length) {
      // 底部已被回收：保持裁剪，不因静默重拉把窗口拉回全量。
      st.window = { start: st.window.start, end: Math.min(st.window.end, next.messages.length) }
    } else {
      st.window = { start: Math.min(st.window.start, base.start), end: next.messages.length }
    }
    if (resetView) {
      st.group.unreadIds = new Set()
      st.workflowStep = null
    }
    // 快照已含该用户消息（或整屏重置）时收起乐观渲染，避免与权威历史重复。
    if (st.pendingUser !== null) {
      if (resetView || hasUserMessage(next.messages, messageText(st.pendingUser))) st.pendingUser = null
    }
    st.finalizeAnnounce = options.announceFinal === true
    store.commit(next, { type: 'snapshot' })
    rerender()
    if (resetView) scrollToBottom()
  }

  async function submitQuestion(vm: any, answers: any[]): Promise<{ ok: boolean; code?: string }> {
    if (vm.itemId === null) return { ok: false, code: 'bad_args' }
    const thread = stateRef.current.viewThread
    const read = (await ctx.command('input.read', thread === null ? null : { thread }, { thread })) as any
    const slots =
      read !== null && read.ok === true && read.value !== null && typeof read.value === 'object' && !Array.isArray(read.value) && read.value.slots !== null && typeof read.value.slots === 'object'
        ? read.value.slots
        : {}
    const directive = slotWriteDirective(slots, thread ?? '_main', { kind: 'question.answer', id: vm.itemId, answers })
    const wrote = (await ctx.submit([directive], { thread })) as any
    if (wrote === null || wrote.ok !== true) return { ok: false, code: wrote?.code ?? 'ui_unreachable' }
    const answered = (await ctx.command('question.answer', null, { thread })) as any
    if (answered === null || answered.ok !== true) return { ok: false, code: answered?.code ?? 'unknown' }
    return { ok: true }
  }

  async function copyText(def: any): Promise<{ ok: boolean }> {
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
  }

  function retryTurn(): void {
    void (async () => {
      const result = (await ctx.command('chat.send', null, { thread: stateRef.current.viewThread })) as any
      if (result === null || result.ok !== true) {
        stateRef.current.error = { code: typeof result?.code === 'string' ? result.code : 'unknown' }
        rerender()
      }
    })()
  }

  /** 回合内从 `chat.message` 槽乐观渲染在途用户消息（回合结束快照即收口）。 */
  async function loadPendingUser(): Promise<void> {
    const st = stateRef.current
    const thread = st.viewThread
    const view = store.getSnapshot()
    if (view.kind === 'group' || view.kind === 'workflow') return
    const read = (await ctx.command('input.read', thread === null ? null : { thread }, { thread })) as any
    if (disposedRef.current || stateRef.current.viewThread !== thread) return
    const value =
      read !== null && read.ok === true && read.value !== null && typeof read.value === 'object' && !Array.isArray(read.value)
        ? read.value
        : null
    const slots =
      value !== null && value.slots !== null && typeof value.slots === 'object' && !Array.isArray(value.slots)
        ? value.slots
        : null
    const def = pendingUserDef(slots === null ? null : slots[thread ?? '_main'])
    if (def === null) return
    // 权威历史已含同文用户消息（重拉 / 重复 run.started）则不乐观渲染，避免重复。
    if (hasUserMessage(store.getSnapshot().messages, messageText(def))) return
    st.pendingUser = def
    rerender()
  }

  function openLightbox(payload: { url: string; alt: string; thumb: HTMLElement | null }): void {
    const machine = createLightboxState()
    machine.open(payload.url, payload.alt)
    stateRef.current.lightbox = { machine, url: payload.url, alt: payload.alt, thumb: payload.thumb, kind: 'image' }
    rerender()
  }

  function openVideo(url: string): void {
    stateRef.current.lightbox = { machine: null, url, alt: '', thumb: null, kind: 'video' }
    rerender()
  }

  function closeLightbox(): void {
    const lb = stateRef.current.lightbox
    stateRef.current.lightbox = null
    rerender()
    if (lb !== null && lb.thumb !== null && typeof lb.thumb.focus === 'function') lb.thumb.focus()
  }

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

  function onScroll(): void {
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
      if (el.scrollTop > anchor.offsetTop + 40) anchor.style.opacity = '0'
    }
    if (el.scrollTop < 32) loadOlder()
  }

  function handleRecord(record: any): void {
    // 任何非增量事件先冲刷在途增量，保证「同连接内按到达顺序 fold」不被合帧打乱。
    flushDeltas()
    const st = stateRef.current
    const payload = record.payload !== null && typeof record.payload === 'object' ? record.payload : {}
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
          st.pendingUser = null
          store.commit(dropInFlight(store.getSnapshot()), { type: 'lifecycle' })
          void apiRef.current.loadHistory(st.viewThread, { resetView: false })
        } else if (st.error !== null && st.error.code === 'ui_unreachable') {
          void apiRef.current.loadHistory(st.viewThread)
        }
      }
      return
    }
    if (record.topic === 'model.delta') {
      if (matchesThread(payload.thread, st.viewThread)) {
        pendingDeltas.current.push(payload)
        scheduleFlush()
      }
      return
    }
    if (record.topic === 'tool.start') {
      if (matchesThread(payload.thread, st.viewThread)) {
        store.commit(applyToolStart(store.getSnapshot(), payload), { type: 'lifecycle' })
      }
      return
    }
    if (record.topic === 'tool.delta') {
      if (matchesThread(payload.thread, st.viewThread)) {
        store.commit(applyToolDelta(store.getSnapshot(), payload), { type: 'lifecycle' })
      }
      return
    }
    if (record.topic === 'tool.end') {
      if (matchesThread(payload.thread, st.viewThread)) {
        store.commit(applyToolEnd(store.getSnapshot(), payload), { type: 'lifecycle' })
      }
      return
    }
    if (record.topic === 'run.started') {
      if (isPeriodicRun(payload.origin)) return
      if (matchesThread(payload.thread, st.viewThread)) {
        store.commit(applyRunStarted(store.getSnapshot(), payload), { type: 'lifecycle' })
        void apiRef.current.loadPendingUser()
      }
      return
    }
    if (record.topic === 'run.finished') {
      if (isPeriodicRun(payload.origin)) return
      if (!matchesThread(payload.thread, st.viewThread)) return
      const folded = foldRunFinished(store.getSnapshot(), payload)
      if (folded.action === 'ignore') return
      store.commit(folded.view, { type: 'lifecycle' })
      if (folded.action === 'cancel') {
        st.pendingUser = null
        rerender()
        return
      }
      void apiRef.current.loadHistory(st.viewThread, { resetView: false, announceFinal: true })
      return
    }
    if (record.topic === 'group.message') {
      if (!matchesThread(dataChangeTarget(payload), st.viewThread)) return
      const id = typeof payload.id === 'string' ? payload.id : typeof payload.message === 'string' ? payload.message : ''
      if (id.length > 0) st.group.unreadIds.add(id)
      void apiRef.current.loadHistory(st.viewThread, { resetView: false })
      return
    }
    if (record.topic === 'workflow.step') {
      if (!matchesThread(dataChangeTarget(payload), st.viewThread)) return
      st.workflowStep = payload
      rerender()
      return
    }
    if (record.topic === 'thread.updated' || record.topic === 'thread.opened' || record.topic === 'thread.closed') {
      if (!matchesThread(dataChangeTarget(payload), st.viewThread)) return
      void apiRef.current.loadHistory(st.viewThread, { resetView: false })
    }
  }

  function onThreadChange(value: any): void {
    // 切线程前先落地在途增量，避免旧线程已收增量丢失或跨线程错配。
    flushDeltas()
    const st = stateRef.current
    st.viewThread = typeof value === 'string' && value.length > 0 ? value : null
    st.pendingUser = null
    store.commit(dropInFlight(store.getSnapshot()), { type: 'lifecycle' })
    st.listOpacity = 0
    rerender()
    void apiRef.current.loadHistory(st.viewThread).then(() => {
      stateRef.current.listOpacity = 1
      rerender()
    })
  }

  // 每次渲染刷新给事件处理器用的函数表（事件处理器只订阅一次，避免反复退订）。
  apiRef.current.loadHistory = loadHistory
  apiRef.current.handleRecord = handleRecord
  apiRef.current.onThreadChange = onThreadChange
  apiRef.current.loadPendingUser = loadPendingUser

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
    }
  }, [])

  // 慢流提示：8s 无首字（正文或推理）才提示「生成中」；有输出即撤。
  const inFlightRun = view.inFlight !== null ? view.inFlight.run : null
  const inFlightOutputLength =
    view.inFlight !== null ? view.inFlight.text.length + view.inFlight.reasoning.length : 0
  useEffect(() => {
    if (inFlightRun === null && inFlightOutputLength === 0) {
      if (stateRef.current.slowStream) {
        stateRef.current.slowStream = false
        rerender()
      }
      return undefined
    }
    if (inFlightOutputLength > 0) {
      if (stateRef.current.slowStream) {
        stateRef.current.slowStream = false
        rerender()
      }
      return undefined
    }
    const timer = setTimeout(() => {
      const latest = store.getSnapshot()
      if (
        latest.inFlight !== null &&
        latest.inFlight.text.length === 0 &&
        latest.inFlight.reasoning.length === 0
      ) {
        stateRef.current.slowStream = true
        rerender()
      }
    }, 8000)
    ;(timer as any).unref?.()
    return () => clearTimeout(timer)
  }, [inFlightRun, inFlightOutputLength, rerender, store])

  // 内容增长：贴底自动贴底；上滑冻结才出胶囊。
  useLayoutEffect(() => {
    const st = stateRef.current
    const key = contentKey(view)
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key
      if (st.atBottom) {
        const el = scrollRef.current
        if (el !== null) el.scrollTop = el.scrollHeight
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

  const env: ChatEnv = {
    ctx,
    table,
    announce,
    openLightbox,
    openVideo,
    submitQuestion,
    copyText,
    retry: retryTurn,
  }

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
          {parentName.length > 0 ? `${agentName} · 由 ${parentName} 触发` : agentName}
        </div>,
      )
    }
    if (view.messages.length === 0 && view.inFlight === null) {
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
    const slice = view.messages.slice(st.window.start, st.window.end)
    const lastEntry = view.messages.length > 0 ? view.messages[view.messages.length - 1] : null
    for (const item of buildDateSeparators(slice, new Date())) {
      if (item.type === 'date') {
        nodes.push(
          <div key={`date-${item.key}`} className="chat-date">
            {item.label}
          </div>,
        )
        continue
      }
      const announce = st.finalizeAnnounce && item.entry === lastEntry && isAssistantEntry(item.entry)
      nodes.push(
        <MessageBoundary key={messageId(item.entry)} fallback={<RenderFallback />}>
          <MessageItem entry={item.entry} announce={announce} />
        </MessageBoundary>,
      )
    }
    // 在途用户消息（乐观）：仅回合进行中渲染，权威快照落地即收起。
    if (st.pendingUser !== null && view.inFlight !== null) {
      nodes.push(
        <MessageBoundary key="pending-user" fallback={<RenderFallback />}>
          <MessageItem entry={{ def: st.pendingUser }} announce={false} />
        </MessageBoundary>,
      )
    }
    if (view.inFlight !== null) {
      nodes.push(
        <MessageBoundary key="stream" fallback={<RenderFallback />}>
          <StreamTurn view={view} slowStream={st.slowStream} />
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
    st.group.anchorEl = null
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
            <div className="chat-bubble-user">{item.text}</div>
          </div>
        ) : (
          <div className="chat-group-item">
            <div className="chat-group-avatar" data-current={String(item.current)}>
              {item.initial}
            </div>
            <div className="chat-group-body">
              {item.showName ? <div className="chat-group-name">{item.speakerName}</div> : null}
              <div className="chat-group-bubble">
                <MessageBoundary fallback={<RenderFallback />}>
                  <GroupItemBody item={item} />
                </MessageBoundary>
              </div>
            </div>
          </div>
        )}
      </Fragment>
    ))
  }

  function renderWorkflow(): ReactNode {
    const graphRef =
      view.conversation !== null &&
      view.conversation.workflow !== undefined &&
      view.conversation.workflow !== null
        ? view.conversation.workflow.graph
        : null
    const graphDef = graphRef !== null && typeof graphRef.def === 'string' ? view.refs[graphRef.def] : null
    const vm = workflowViewModel({ conversation: view.conversation, graphDef, step: st.workflowStep })
    const fillWidth = vm.total > 0 ? `${Math.min(100, Math.round(((vm.index + 1) / vm.total) * 100))}%` : null
    return (
      <div className="chat-workflow">
        <div className="chat-workflow-title">{vm.title}</div>
        <div className="chat-workflow-meta">
          <span>{vm.total > 0 ? formatText('chat_step_progress', { index: vm.index + 1, total: vm.total }) : ''}</span>
          <span>{` · ${statusText(vm.status)}`}</span>
        </div>
        <div className="chat-workflow-track">
          <div className="chat-workflow-fill" style={fillWidth !== null ? { width: fillWidth } : undefined} />
        </div>
        <details>
          <summary>{lookupMessage(table, 'chat_node_list').body}</summary>
          {vm.nodes.map((node: any, index: number) => (
            <div key={index} className="chat-workflow-node" data-status={node.status}>
              <Icon name={statusIcon(node.status)} size={16} />
              <span>{`#${node.index} ${node.name}`}</span>
              <span className="chat-workflow-meta">{node.impl}</span>
              <span>{statusText(node.status)}</span>
            </div>
          ))}
        </details>
        {vm.rejectCode !== null ? (
          <div className="chat-error">
            <div>{lookupMessage(table, vm.rejectCode).body}</div>
            <button type="button" className="chat-btn" onClick={() => retryTurn()}>
              {lookupMessage(table, 'chat_retry').body}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  function renderList(): ReactNode {
    const errorBar =
      st.error !== null ? (
        <ErrorBar error={st.error} onRetry={() => void loadHistory(st.viewThread)} />
      ) : null
    // 已有内容时，历史重拉失败只提示、不清空会话：瞬时超时不应抹掉已渲染消息。
    const hasContent = store.getSnapshot().messages.length > 0
    if (errorBar !== null && !hasContent) return errorBar
    if (st.loading && !hasContent) {
      return (
        <div className="chat-block-loading">
          <div className="chat-breathe" />
          {st.loadingNote ? <div className="chat-workflow-meta">{lookupMessage(table, 'chat_loading').body}</div> : null}
        </div>
      )
    }
    const body =
      view.kind === 'group' ? renderGroup() : view.kind === 'workflow' ? renderWorkflow() : renderConversation()
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
            if (target !== null && target.tagName === 'IMG') {
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
  ctx.slots.register({ name: 'main' }, App)
}
