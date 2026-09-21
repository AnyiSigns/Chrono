// 工具面自述（`tool-shell.describe` 的输出）：单工具 `shell` + 描述四要素 + argsSchema + caps + render。
// 形状对齐 `tool` 端口契约：四要素必填非空、`param_semantics` 覆盖必填参数、`caps` 对象形含 `fs.read`；
// render 为可折叠卡片 + 终端展开的渲染描述符。

import type { Json, Rec } from './types.ts'

/** mode=code 支持的语言白名单（v1）。 */
export const LANGUAGES: readonly string[] = ['javascript', 'python', 'shell']

/** 声明上限：与 sandbox caps 形状一致；实际执行取「声明 ∩ 当前权限档」。 */
export const DEFAULT_CAPS: Rec = {
  fs: { read: 'workspace', write: 'workspace' },
  net: 'none',
  cpu_ms: 60000,
  mem_mb: 512,
  timeout_ms: 120000,
  output_max: 1048576,
  procs_max: 32,
}

/** 一次回报本插件暴露的全部工具（本插件只有一个 shell）。 */
export function describeTools(): Json {
  return { tools: [shellTool()] }
}

function shellTool(): Rec {
  return {
    name: 'shell',
    intent: '在隔离环境中执行一条命令或一段代码片段。',
    when_to_use: '需要跑构建 / 测试 / 脚本 / 一次性计算，或临时执行一段代码验证想法时。',
    param_semantics: {
      mode: "'command' 跑一条命令；'code' 跑脚本 / 表达式并按结构化结果回；缺省 'command'。",
      input: '命令串或代码片段。',
      language: "mode=code 时的语言，取白名单之一（javascript / python / shell）。",
    },
    boundaries:
      '不做结构化文件读写（找文件用 glob、读文件用 read、改文件用 edit）；不绕过 guard / sandbox；不做交互式会话。',
    description: '在隔离环境执行命令或代码；返回 {kind, exit_code, stdout, stderr, truncated}。',
    argsSchema: {
      type: 'object',
      properties: {
        mode: {
          enum: ['command', 'code'],
          description: "输入形态：command 跑一条命令；code 跑脚本 / 表达式。",
        },
        input: { type: 'string', minLength: 1, description: '命令串或代码片段。' },
        language: {
          enum: LANGUAGES,
          description: 'mode=code 时的语言（白名单）。',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    caps: DEFAULT_CAPS,
    idempotent: false,
    modes: ['command', 'code'],
    languages: LANGUAGES,
    render: {
      form: 'card',
      label: 'shell',
      summary: '{input}',
      tone: 'plain',
      detail: { kind: 'terminal' },
      live: false,
    },
  }
}
