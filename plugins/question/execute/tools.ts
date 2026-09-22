// 工具面自述（`question.describe` 的输出）与问题载荷规范化 / 交互卡描述符。
// 工具名 = `question`；四要素必填；render.detail.kind = `question`（#18 交互渲染器，字段口径见 DESIGN「渲染」）。
// caps 与 #25 一致（对象形 fs + 字符串 net）；写类 / 有会话类工具 idempotent:false。

import { asArray, asString, isRecord } from './plan.ts'
import type { QuestionConfig } from './config.ts'
import type { Json, Rec } from './types.ts'

/** 能力声明（无 fs / net：本工具只产写计划与事件，不触文件与网络）。 */
const CAPS: Rec = {
  fs: { read: 'none', write: 'none' },
  net: 'none',
  timeout_ms: 30000,
  mem_mb: 256,
  output_max: 1048576,
  procs_max: 1,
}

/** `describe` 的 render 描述符：折叠态标签 question，展开态交 #18 的 question 交互渲染器。 */
const RENDER: Rec = {
  form: 'card',
  label: 'question',
  summary: '{header}',
  tone: 'plain',
  detail: { kind: 'question' },
}

/** `question` 工具的 argsSchema：问题数组 + 逐项形状（上限取自本插件 schema）。 */
function argsSchema(config: QuestionConfig): Rec {
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: config.maxQuestions,
        description: '要问用户的问题列表；每项含 id / header / question / options / multiple / custom。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '问题 id（答案按它回填）。' },
            header: { type: 'string', description: '卡面标题（渲染 summary）。' },
            question: { type: 'string', description: '问题正文。' },
            options: {
              type: 'array',
              maxItems: config.maxOptions,
              items: { type: 'object' },
              description: '选项列表；空 = 纯开放作答。',
            },
            multiple: { type: 'boolean', description: '是否多选。' },
            custom: { type: 'boolean', description: '是否允许自定义输入。' },
          },
          required: ['id', 'question'],
          additionalProperties: true,
        },
      },
    },
    required: ['questions'],
    additionalProperties: true,
  }
}

/** `question.describe` 的输出值（工具清单；模型可见文本由四要素拼装，这里直给 description）。 */
export function describeValue(config: QuestionConfig): Json {
  const tool: Rec = {
    name: 'question',
    intent: '向用户提出一个或多个问题并等待作答；本回合正常结束，用户作答后由续跑把答案回灌为本次工具调用的结果。',
    when_to_use:
      '需要用户补充信息、在若干方案里做选择、或确认 agent 无法自行决定的事项时。',
    param_semantics: {
      questions:
        '问题数组，每项 {id, header, question, options[], multiple, custom}；options 为空即纯开放作答，multiple 允许多选，custom 允许自定义输入。',
    },
    boundaries:
      '不阻塞等待、不自动作答、不做审批门禁（审批归 approval）、不写其他身份；一次提问本回合即结束，答案在后续回合回灌。',
    description:
      '向用户提问并等待回答：把问题队列项写入世界后本回合结束；用户作答后续跑，答案作为本工具结果回灌。',
    argsSchema: argsSchema(config),
    caps: CAPS,
    idempotent: false,
    render: RENDER,
  }
  return { tools: [tool] }
}

/** 问题载荷校验结果。 */
export type NormalizedQuestions =
  | { ok: true; questions: Rec[] }
  | { ok: false; code: string; message: string }

function normalizeOption(value: Json): Rec | null {
  if (!isRecord(value)) return null
  const label = asString(value['label'])
  if (label === null) return null
  const option: Rec = { label }
  const description = asString(value['description'])
  if (description !== null) option['description'] = description
  return option
}

/**
 * 规范化 / 校验 `questions`：逐项查 id / question / options / multiple / custom，
 * 越界（问题数 / 选项数 / custom 禁用）回结构化错误码，不静默截断。
 */
export function normalizeQuestions(value: Json | undefined, config: QuestionConfig): NormalizedQuestions {
  const list = asArray(value)
  if (list === null || list.length === 0) {
    return { ok: false, code: 'bad_questions', message: 'questions must be a non-empty array' }
  }
  if (list.length > config.maxQuestions) {
    return { ok: false, code: 'too_many_questions', message: `${list.length} > ${config.maxQuestions}` }
  }
  const questions: Rec[] = []
  for (const raw of list) {
    if (!isRecord(raw)) return { ok: false, code: 'bad_questions', message: 'question must be an object' }
    const id = asString(raw['id'])
    const question = asString(raw['question'])
    if (id === null) return { ok: false, code: 'missing_question_id', message: 'question.id required' }
    if (question === null) {
      return { ok: false, code: 'missing_question_text', message: 'question.question required' }
    }
    const header = asString(raw['header'])
    const optionsRaw = asArray(raw['options']) ?? []
    if (optionsRaw.length > config.maxOptions) {
      return { ok: false, code: 'too_many_options', message: `${optionsRaw.length} > ${config.maxOptions}` }
    }
    const options: Rec[] = []
    for (const option of optionsRaw) {
      const normalized = normalizeOption(option)
      if (normalized === null) {
        return { ok: false, code: 'bad_option', message: 'option.label required' }
      }
      options.push(normalized)
    }
    const multiple = raw['multiple'] === true
    const custom = raw['custom'] === true
    if (custom && !config.allowCustom) {
      return { ok: false, code: 'custom_not_allowed', message: id }
    }
    const normalized: Rec = { id, header: header ?? '', question, options, multiple, custom }
    questions.push(normalized)
  }
  return { ok: true, questions }
}

/** 折叠态摘要：取首个问题的 header（缺省 'question'）。 */
function cardSummary(item: Rec): string {
  const first = asArray(item['questions'])?.[0]
  if (isRecord(first)) {
    const header = asString(first['header'])
    if (header !== null) return header
  }
  return 'question'
}

/** 交互卡描述符（随 invoke 结果返回，由 #33 落消息 part 进 #11）：字段口径见 DESIGN「渲染」。 */
export function renderCard(item: Rec): Rec {
  return {
    form: 'card',
    label: 'question',
    summary: cardSummary(item),
    tone: 'plain',
    detail: {
      kind: 'question',
      interactive: true,
      id: item['id'],
      questions: item['questions'] ?? [],
      expired: item['expired'] === true,
      answers: item['answers'] ?? null,
    },
  }
}
