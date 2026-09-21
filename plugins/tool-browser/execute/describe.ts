// 工具面自述（`tool-browser.describe` 的输出）：单工具 `webbrowser` + 描述四要素 + argsSchema + caps + render。
// 形状对齐 `plugins/tools/DESIGN.md`「`tool` 端口契约」：四要素必填非空、`param_semantics` 覆盖必填参数、
// `caps` 对象形含 `fs.read`；render 的 `detail.kind` 必须静态（单工具只能声明一个展开态渲染器）。

import type { Json } from './types.ts'

/** 单工具名（全局唯一，模型可见）。 */
export const TOOL_NAME = 'webbrowser'

const ACTIONS = ['open', 'navigate', 'click', 'type', 'press', 'wait_for', 'extract', 'screenshot', 'close']

function caps(): Json {
  return {
    fs: { read: 'none', write: 'none' },
    // 与 sandbox 档位表同口径：net 只认字符串 none/limited/all。
    // 浏览器可导航任意 host，声明需求是 all；severe(limited)/review/deny 越档即 net_denied。
    net: 'all',
    timeout_ms: 120000,
    mem_mb: 2048,
    output_max: 1048576,
    procs_max: 64,
  }
}

function argsSchema(): Json {
  return {
    type: 'object',
    properties: {
      action: {
        enum: ACTIONS,
        description: '要执行的动作，决定后续参数与结果形状。',
      },
      session: {
        type: 'string',
        minLength: 1,
        description: '会话 id：open 缺省新开；其余动作必填。',
      },
      url: { type: 'string', minLength: 1, description: 'navigate 的目标 URL（http/https）。' },
      selector: { type: 'string', minLength: 1, description: 'CSS 选择器（click / type / wait_for / extract）。' },
      text: { type: 'string', description: 'type 要输入的文本。' },
      key: { type: 'string', minLength: 1, description: 'press 的按键名，如 Enter / Tab；向当前焦点元素派发真实 keydown / keyup。' },
      submit: { type: 'boolean', description: 'type 后是否提交所在表单；缺省 false。' },
      wait_until: {
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: 'navigate 的等待条件；缺省 load。',
      },
      ms: { type: 'integer', minimum: 0, description: 'wait_for 的等待毫秒数。' },
      attr: { type: 'string', description: 'extract 的属性名；给出则回属性值，缺省回文本。' },
      full_page: { type: 'boolean', description: 'screenshot 是否整页；缺省 false。' },
      format: { enum: ['png', 'jpeg'], description: 'screenshot 的图片格式；缺省按 schema。' },
      viewport: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: { type: 'integer', minimum: 1, description: '视口宽。' },
          height: { type: 'integer', minimum: 1, description: '视口高。' },
        },
        description: 'open 的视口覆盖；缺省按 schema。',
      },
    },
    required: ['action'],
    additionalProperties: false,
  }
}

function tool(): Json {
  return {
    name: TOOL_NAME,
    intent: '在一个持久浏览器会话里导航、点击 / 输入 / 按键、等待、抽取文本或截图。',
    when_to_use: '需要执行 JS 渲染、跨多步保持页面状态（登录 / 表单 / 多页跳转）或对页面截图时。',
    param_semantics: {
      action: '动作分档：open 起会话、navigate 导航、click / type / press / wait_for 交互、extract 抽取、screenshot 截图、close 关会话。',
      session: '会话 id：open 缺省新开并返回；其余动作引用已存在会话，未知 / 过期回 session_not_found。',
      url: 'navigate 的目标地址；仅支持 http / https。',
      selector: 'CSS 选择器；未命中或等待超时回 element_not_found。',
      text: 'type 要写入的文本。',
      key: 'press 的按键名，如 Enter；向当前焦点元素派发真实 keydown / keyup，触发浏览器默认行为（如表单提交）。',
      submit: 'type 完成后是否提交所在表单；缺省 false。',
      wait_until: 'navigate 的等待条件：load（缺省）/ domcontentloaded / networkidle。',
      ms: 'wait_for 的等待毫秒数；与 selector 二选一或并用。',
      attr: 'extract 的属性名；给出回 {value}，缺省回 {text}（缺省选择器为正文）。',
      full_page: 'screenshot 是否截整页；缺省 false（仅视口）。',
      format: 'screenshot 的图片格式 png / jpeg；缺省按身份 schema。',
      viewport: 'open 的视口覆盖 {width, height}；缺省按身份 schema。',
    },
    boundaries: '有会话 / 有状态：不用于无状态抓取（无状态抓取归 webfetch）；不做工具语义判定与派发；截图字节走资产引用，不写工作区。',
    description: '浏览器自动化：单工具 webbrowser，用 action 分档（会话化导航 / 交互 / 抽取 / 截图）。',
    argsSchema: argsSchema(),
    caps: caps(),
    idempotent: false,
    render: {
      form: 'card',
      label: TOOL_NAME,
      summary: '{action}  {url}',
      tone: 'plain',
      detail: { kind: 'json' },
      live: false,
    },
    modes: ACTIONS,
  }
}

/** 一次回报本插件暴露的全部工具（单工具 `webbrowser`）。 */
export function describe(): Json {
  return { tools: [tool()] }
}
