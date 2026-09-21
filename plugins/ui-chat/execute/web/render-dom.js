// DOM 渲染器：把视图模型画成元素。所有用户文本经 markdown + sanitize 或 textContent 落地，
// 不用未消毒的 innerHTML。交互回调（复制 / 重试 / 提交 / lightbox）由 entry.js 注入。

import { el, icon, iconButton } from './dom.js'
import { escapeHtml, renderMarkdown } from './markdown.js'
import { sanitizeHtml } from './sanitize.js'
import { messageText } from './history-model.js'
import { messageViewItems, safeStringify } from './render-parts.js'
import { toolCardViewModel } from './tool-card.js'
import { detailViewModel } from './detail-renderers.js'
import { usageText } from './usage.js'
import { lookupMessage } from './messages.js'

/** 安全写入 markdown（渲染 + 白名单消毒）。 */
export function setMarkdown(doc, node, text) {
  node.innerHTML = sanitizeHtml(renderMarkdown(text))
}

/** 创建渲染器集合；`ctx` 提供 doc / assetUrl / table / 交互回调。 */
export function createRenderers(ctx) {
  const { doc, assetUrl, table } = ctx

  function mediaUrl(source) {
    if (source === null) return null
    if (source.kind === 'ext') return source.url
    return assetUrl(source)
  }

  function placeholder(text, onRetry) {
    const node = el(doc, 'div', { class: 'chat-placeholder' }, [
      icon(doc, 'alert-circle', 16),
      el(doc, 'span', { text }),
    ])
    if (typeof onRetry === 'function') {
      node.appendChild(
        el(doc, 'button', { class: 'chat-btn', text: lookupMessage(table, 'chat_retry').body, on: { click: onRetry } }),
      )
    }
    return node
  }

  function imageItem(source, alt) {
    const url = mediaUrl(source)
    if (url === null) return placeholder(lookupMessage(table, 'chat_media_failed').body, null)
    const build = () => {
      const altText = alt || lookupMessage(table, 'chat_image').body
      const img = el(doc, 'img', {
        class: 'chat-media-img',
        attrs: { src: url, alt: altText, loading: 'lazy' },
      })
      img.addEventListener('click', () => ctx.onOpenLightbox(source, altText, img))
      img.addEventListener('error', () => {
        const failed = placeholder(lookupMessage(table, 'chat_media_failed').body, () => failed.replaceWith(build()))
        img.replaceWith(failed)
      })
      return img
    }
    return build()
  }

  function videoItem(source) {
    const url = mediaUrl(source)
    if (url === null) return placeholder(lookupMessage(table, 'chat_media_failed').body, null)
    const video = el(doc, 'video', {
      class: 'chat-media-video',
      attrs: { src: url, preload: 'metadata' },
    })
    video.muted = true
    const button = el(doc, 'button', {
      class: 'chat-video-play',
      attrs: { type: 'button', 'aria-label': lookupMessage(table, 'chat_play_video').body },
      text: lookupMessage(table, 'chat_play_video').body,
    })
    button.addEventListener('click', () => ctx.onOpenVideo(source))
    return el(doc, 'div', { class: 'chat-video-thumb' }, [video, button])
  }

  function audioItem(source) {
    const url = mediaUrl(source)
    if (url === null) return placeholder(lookupMessage(table, 'chat_media_failed').body, null)
    return el(doc, 'audio', { class: 'chat-media-audio', attrs: { src: url, controls: true, preload: 'none' } })
  }

  function fileItem(name, source) {
    const url = mediaUrl(source)
    const inner = [
      icon(doc, 'paperclip', 16),
      el(doc, 'span', { class: 'chat-file-name', text: name }),
    ]
    if (url === null) return el(doc, 'div', { class: 'chat-file' }, inner)
    return el(
      doc,
      'a',
      {
        class: 'chat-file',
        attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', download: name },
      },
      inner,
    )
  }

  function detailNode(detail) {
    const vm = detailViewModel(detail)
    switch (vm.kind) {
      case 'text': {
        const node = el(doc, 'div', { class: 'chat-md' })
        setMarkdown(doc, node, vm.text)
        return node
      }
      case 'code':
        return el(doc, 'pre', { class: 'chat-code-block', text: vm.text })
      case 'diff':
        return diffNode(vm)
      case 'matches':
        return el(
          doc,
          'div',
          { class: 'chat-matches' },
          vm.items.map((item) =>
            el(doc, 'div', {}, [
              el(doc, 'span', { class: 'chat-matches-line', text: `${item.path}:${item.line}  ` }),
              el(doc, 'span', { text: item.text }),
            ]),
          ),
        )
      case 'paths':
        return el(
          doc,
          'div',
          { class: 'chat-paths' },
          vm.items.map((item) => el(doc, 'div', {}, [icon(doc, 'folder', 16), el(doc, 'span', { text: item })])),
        )
      case 'list':
        return el(
          doc,
          'ul',
          { class: 'chat-list-detail' },
          vm.items.map((item) =>
            el(doc, 'li', { text: typeof item === 'string' ? item : safeStringify(item) }),
          ),
        )
      case 'table': {
        const thead =
          vm.columns.length > 0
            ? el(doc, 'thead', {}, [el(doc, 'tr', {}, vm.columns.map((column) => el(doc, 'th', { text: column })))])
            : null
        const tbody = el(
          doc,
          'tbody',
          {},
          vm.rows.map((row) => el(doc, 'tr', {}, row.map((cell) => el(doc, 'td', { text: cell })))),
        )
        return el(doc, 'table', { class: 'chat-table' }, [thead, tbody])
      }
      case 'json':
        return el(doc, 'pre', { class: 'chat-code-block', text: vm.text })
      case 'file':
        return fileItem(vm.name, vm.source)
      case 'image':
        return imageItem(vm.source, '')
      case 'terminal':
        return terminalNode(vm)
      case 'question':
        return questionCard(vm)
      default: {
        const node = el(doc, 'div', { class: 'chat-md' })
        setMarkdown(doc, node, vm.text ?? '')
        return node
      }
    }
  }

  function diffNode(vm) {
    const rows = vm.rows.map((row) => {
      if (row.type === 'hunk') {
        return el(doc, 'div', {
          class: 'chat-diff-row chat-diff-hunk',
          text: row.text ?? `… 折叠 ${row.count} 行 …`,
        })
      }
      if (row.type === 'mod') {
        return el(doc, 'div', { class: 'chat-diff-row chat-diff-mod', text: `~ ${row.before} → ${row.after}` })
      }
      if (row.type === 'add') return el(doc, 'div', { class: 'chat-diff-row chat-diff-add', text: `+ ${row.text}` })
      if (row.type === 'del') return el(doc, 'div', { class: 'chat-diff-row chat-diff-del', text: `- ${row.text}` })
      return el(doc, 'div', { class: 'chat-diff-row chat-diff-ctx', text: `  ${row.text}` })
    })
    return el(doc, 'div', { class: 'chat-diff' }, rows)
  }

  function terminalNode(vm) {
    const children = []
    if (vm.stdout.length > 0) children.push(el(doc, 'div', { class: 'chat-terminal-stdout', text: vm.stdout }))
    if (vm.stderr.length > 0) children.push(el(doc, 'div', { class: 'chat-terminal-stderr', text: vm.stderr }))
    if (vm.exitCode !== null) {
      children.push(el(doc, 'div', { class: 'chat-terminal-exit', text: `退出码 ${vm.exitCode}` }))
    }
    if (children.length === 0) children.push(el(doc, 'div', { class: 'chat-breathe' }))
    return el(doc, 'div', { class: 'chat-terminal' }, children)
  }

  /** question 交互卡：单选 / 多选 / 自定义输入 / 提交；已答折叠；expired 禁用。 */
  function questionCard(vm) {
    const root = el(doc, 'div', { class: 'chat-question', dataset: { expired: String(vm.expired) } })
    if (vm.answered) {
      root.appendChild(answeredRecord(vm))
      return root
    }
    const selections = new Map()
    const customs = new Map()
    for (const question of vm.questions) {
      selections.set(question.id, new Set())
      const group = el(doc, 'div', {
        class: 'chat-question-group',
        attrs: question.multiple ? { role: 'group', 'aria-label': question.header || question.question } : { role: 'radiogroup', 'aria-label': question.header || question.question },
      })
      if (question.header.length > 0) group.appendChild(el(doc, 'div', { class: 'chat-question-q', text: question.header }))
      group.appendChild(el(doc, 'div', { text: question.question }))
      const optionNodes = []
      for (const option of question.options) {
        const optionNode = el(
          doc,
          'div',
          {
            class: 'chat-question-opt',
            attrs: {
              role: question.multiple ? 'checkbox' : 'radio',
              tabindex: vm.expired ? -1 : 0,
              'aria-checked': 'false',
              'aria-disabled': String(vm.expired),
            },
          },
          [
            el(doc, 'span', { text: option.label }),
            option.description.length > 0 ? el(doc, 'span', { class: 'chat-question-opt-desc', text: option.description }) : null,
          ],
        )
        const toggle = () => {
          if (vm.expired) return
          const set = selections.get(question.id)
          if (question.multiple) {
            if (set.has(option.label)) set.delete(option.label)
            else set.add(option.label)
          } else {
            set.clear()
            set.add(option.label)
            for (const other of optionNodes) other.setAttribute('aria-checked', 'false')
          }
          optionNode.setAttribute('aria-checked', String(set.has(option.label)))
        }
        optionNode.addEventListener('click', toggle)
        optionNode.addEventListener('keydown', (event) => {
          if (event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault()
            toggle()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (!question.multiple && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            const index = optionNodes.indexOf(optionNode)
            const next = event.key === 'ArrowDown' ? (index + 1) % optionNodes.length : (index - 1 + optionNodes.length) % optionNodes.length
            optionNodes[next].focus()
            optionNodes[next].click()
          }
        })
        optionNodes.push(optionNode)
        group.appendChild(optionNode)
      }
      if (question.custom) {
        const input = el(doc, 'input', {
          class: 'chat-question-input',
          attrs: { type: 'text', placeholder: lookupMessage(table, 'chat_custom_input').body, 'aria-label': `${lookupMessage(table, 'chat_custom_answer').body}：${question.header || question.question}`, disabled: vm.expired },
        })
        input.addEventListener('input', () => customs.set(question.id, input.value))
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        })
        group.appendChild(input)
      }
      root.appendChild(group)
    }

    const error = el(doc, 'span', { class: 'chat-danger-inline', hidden: true })
    const submitButton = el(doc, 'button', {
      class: 'chat-btn chat-btn-accent',
      text: lookupMessage(table, 'chat_submit').body,
      attrs: { type: 'button', disabled: vm.expired },
    })
    const actions = el(doc, 'div', { class: 'chat-question-actions' }, [submitButton, error])
    root.appendChild(actions)

    function collectAnswers() {
      const answers = []
      for (const question of vm.questions) {
        const selected = Array.from(selections.get(question.id) ?? [])
        const custom = (customs.get(question.id) ?? '').trim()
        if (selected.length === 0 && custom.length === 0) continue
        const answer = { question_id: question.id, selected }
        if (custom.length > 0) answer.custom = custom
        answers.push(answer)
      }
      return answers
    }

    async function submit() {
      if (vm.expired) return
      const answers = collectAnswers()
      if (answers.length === 0) {
        error.hidden = false
        error.textContent = lookupMessage(table, 'chat_answer_required').body
        return
      }
      error.hidden = true
      submitButton.disabled = true
      submitButton.replaceChildren(el(doc, 'span', { class: 'chat-breathe chat-breathe-inline' }), el(doc, 'span', { text: lookupMessage(table, 'chat_submitting').body }))
      const result = await ctx.onQuestionSubmit(vm, answers)
      if (result !== null && result.ok === true) {
        root.replaceChildren(answeredRecord({ ...vm, answered: true, answers: answers.map((a) => ({ questionId: a.question_id, selected: a.selected, custom: a.custom ?? null })) }))
        return
      }
      submitButton.disabled = false
      submitButton.textContent = lookupMessage(table, 'chat_submit').body
      error.hidden = false
      error.textContent = lookupMessage(table, result !== null && result.code ? result.code : 'unknown').body
    }
    submitButton.addEventListener('click', submit)

    if (vm.expired) {
      root.insertBefore(
        el(doc, 'div', { class: 'chat-warning-inline' }, [
          icon(doc, 'alert-triangle', 16),
          el(doc, 'span', { text: lookupMessage(table, 'chat_expired').body }),
        ]),
        root.firstChild,
      )
    }
    return root
  }

  function answeredRecord(vm) {
    const node = el(doc, 'div', { class: 'chat-question' })
    for (const question of vm.questions) {
      const answer = vm.answers.find((item) => item.questionId === question.id)
      const parts = []
      if (answer !== undefined) parts.push(...answer.selected)
      if (answer !== undefined && answer.custom !== null && answer.custom.length > 0) parts.push(answer.custom)
      node.appendChild(
        el(doc, 'div', {}, [
          el(doc, 'div', { class: 'chat-question-q', text: question.header || question.question }),
          el(doc, 'div', { class: 'chat-muted', text: parts.join('、') }),
        ]),
      )
    }
    return node
  }

  /** 工具卡：line / card / degraded；card 可折叠。 */
  function toolCard(vm, options = {}) {
    if (vm.form === 'degraded') {
      const node = el(doc, 'div', { class: 'chat-md' })
      setMarkdown(doc, node, vm.text)
      return node
    }
    const card = el(doc, 'div', { class: `chat-tool chat-tool-${vm.tone}`, dataset: { open: 'false' } })
    if (vm.form === 'line') {
      card.appendChild(
        el(doc, 'div', { class: 'chat-tool-line' }, [
          el(doc, 'span', { class: 'chat-tool-label', text: vm.label }),
          el(doc, 'span', { class: 'chat-tool-summary', text: vm.summary }),
        ]),
      )
      return card
    }
    const chevron = icon(doc, 'chevron-right', 16)
    chevron.setAttribute('class', 'chat-tool-chevron')
    const head = el(doc, 'button', { class: 'chat-tool-head', attrs: { type: 'button', 'aria-expanded': 'false' } }, [
      chevron,
      el(doc, 'span', { class: 'chat-tool-label', text: vm.label }),
      el(doc, 'span', { class: 'chat-tool-summary', text: vm.summary }),
    ])
    const detail = el(doc, 'div', { class: 'chat-tool-detail', hidden: true })
    head.addEventListener('click', () => {
      const open = card.dataset.open !== 'true'
      card.dataset.open = String(open)
      head.setAttribute('aria-expanded', String(open))
      detail.hidden = !open
      if (open && detail.childElementCount === 0) {
        detail.appendChild(options.detailNode !== undefined ? options.detailNode() : detailNode(vm.detail))
      }
    })
    card.appendChild(head)
    card.appendChild(detail)
    return card
  }

  function renderItem(vm) {
    if (vm.type === 'text') {
      const node = el(doc, 'div', { class: 'chat-md' })
      setMarkdown(doc, node, vm.text)
      return node
    }
    if (vm.type === 'image') return imageItem(vm.source, vm.alt)
    if (vm.type === 'video') return videoItem(vm.source)
    if (vm.type === 'audio') return audioItem(vm.source)
    if (vm.type === 'file') return fileItem(vm.name, vm.source)
    if (vm.type === 'tool') return toolCard(toolCardViewModel(vm))
    const node = el(doc, 'div', { class: 'chat-md' })
    setMarkdown(doc, node, safeStringify(vm))
    return node
  }

  function footnote(def, options = {}) {
    const children = []
    const usage = usageText(def)
    if (usage !== null) children.push(el(doc, 'span', { class: 'chat-usage', text: usage }))
    const copyButton = iconButton(doc, 'copy', lookupMessage(table, 'chat_copy').body, () => ctx.onCopy?.(copyButton, def))
    children.push(copyButton)
    if (options.showRetry === true) {
      children.push(iconButton(doc, 'rotate-ccw', lookupMessage(table, 'chat_retry').body, () => ctx.onRetry?.()))
    }
    return el(doc, 'div', { class: 'chat-footnote' }, children)
  }

  function message(entry) {
    const def = entry !== null && typeof entry === 'object' ? entry.def : null
    const role = def !== null && typeof def.role === 'string' ? def.role : 'assistant'
    if (role === 'user') {
      const bubble = el(doc, 'div', { class: 'chat-bubble-user' })
      const items = messageViewItems(def)
      if (items.length === 0) bubble.textContent = messageText(def)
      for (const item of items) {
        if (item.type === 'text') bubble.appendChild(el(doc, 'div', { text: item.text }))
        else bubble.appendChild(renderItem(item))
      }
      return el(doc, 'div', { class: 'chat-msg chat-msg-user' }, [bubble])
    }
    if (role === 'system') {
      const errorCode = def !== null && def.meta !== undefined && def.meta !== null && typeof def.meta.error === 'string' ? def.meta.error : 'unknown'
      return el(doc, 'div', { class: 'chat-msg chat-msg-assistant' }, [
        el(doc, 'div', { class: 'chat-system' }, [
          el(doc, 'div', { class: 'chat-error-title', text: lookupMessage(table, errorCode).title || lookupMessage(table, 'chat_system_message').body }),
          el(doc, 'div', { text: lookupMessage(table, errorCode).body }),
        ]),
      ])
    }
    const body = el(doc, 'div', { class: 'chat-msg-assistant-body' }, messageViewItems(def).map(renderItem))
    const showRetry = def !== null && def.meta !== undefined && def.meta !== null && typeof def.meta.error === 'string'
    return el(doc, 'div', { class: 'chat-msg chat-msg-assistant' }, [body, footnote(def, { showRetry })])
  }

  function errorBar(error, onRetry) {
    const entry = lookupMessage(table, error !== null && typeof error.code === 'string' ? error.code : 'unknown')
    const retry = el(doc, 'button', { class: 'chat-btn', text: entry.action ?? lookupMessage(table, 'chat_retry').body })
    retry.addEventListener('click', () => onRetry?.())
    return el(doc, 'div', { class: 'chat-error' }, [
      icon(doc, 'alert-circle', 16),
      el(doc, 'div', {}, [
        el(doc, 'div', { class: 'chat-error-title', text: entry.title || lookupMessage(table, 'chat_error').body }),
        el(doc, 'div', { text: entry.body }),
      ]),
      retry,
    ])
  }

  return {
    setMarkdown,
    placeholder,
    imageItem,
    videoItem,
    audioItem,
    fileItem,
    detailNode,
    questionCard,
    toolCard,
    renderItem,
    footnote,
    message,
    errorBar,
  }
}
