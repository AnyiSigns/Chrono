// 工具面自述（`plugin-admin.describe` 的输出）：四个工具 + 描述四要素 + 工具卡 render 描述符。
// 工具名带 `plugin.` 前缀全局唯一；render 形状对齐「工具卡渲染」契约。
// 高危写类 `plugin.write` 用 solid（实底），只读类同色以标明同一管理面。

import type { Json, Rec } from './types.ts'

/** 能力声明（与执行件能力声明同形：`{fs:{read,write}, net}` 对象形）。 */
const READONLY_CAPS: Rec = {
  fs: { read: 'none', write: 'none' },
  net: false,
  timeout_ms: 30000,
  mem_mb: 256,
  output_max: 2097152,
  procs_max: 1,
}

const IDENTITY_ARG: Rec = { type: 'string', description: '目标插件名。' }
const FILES_ARG: Rec = {
  type: 'object',
  description: '候选源码树：包内相对路径 → 文本内容。',
}

/** 四个工具的自述（name / 四要素 / argsSchema / caps / idempotent / render）。 */
export const TOOLS: Json[] = [
  {
    name: 'plugin.list',
    intent: '列出可管理的插件。',
    when_to_use: '需要了解有哪些插件、各自提供什么能力时。',
    param_semantics: {},
    boundaries: '只列清单，不含源码；查看源码用 plugin.read。',
    description: '列出可管理的插件（id / active / implements / commands）。',
    argsSchema: { type: 'object', properties: {}, additionalProperties: true },
    caps: READONLY_CAPS,
    idempotent: true,
    render: { form: 'card', label: 'plugin', summary: 'list', tone: 'solid', detail: { kind: 'list' } },
  },
  {
    name: 'plugin.read',
    intent: '读取某个插件的源码文件内容。',
    when_to_use: '需要查看某插件实现、定位要修改的文件时。',
    param_semantics: {
      identity: '目标插件名。',
      path: '包内相对路径（如 execute/main.ts）。',
    },
    boundaries: '只读单个文件，不列目录；改源码用 plugin.write。',
    description: '按路径读取某插件的一个源码文件，返回内容与字节数。',
    argsSchema: {
      type: 'object',
      properties: { identity: IDENTITY_ARG, path: { type: 'string', description: '包内相对路径。' } },
      required: ['identity', 'path'],
      additionalProperties: true,
    },
    caps: READONLY_CAPS,
    idempotent: true,
    render: {
      form: 'card',
      label: 'plugin',
      summary: 'read  {identity}',
      tone: 'solid',
      detail: { kind: 'code' },
    },
  },
  {
    name: 'plugin.validate',
    intent: '校验一份候选插件源码是否可安装，返回错误列表与校验结果。',
    when_to_use: '准备提交插件源码改动之前，先校验候选包。',
    param_semantics: {
      identity: '候选插件名，须与候选包内声明一致。',
      files: '候选源码树（路径 → 文本）。',
    },
    boundaries: '只校验、不改动任何插件；提交改动用 plugin.write。',
    description: '校验候选插件源码，返回 {ok, errors, result_hash}。',
    argsSchema: {
      type: 'object',
      properties: { identity: IDENTITY_ARG, files: FILES_ARG },
      required: ['identity', 'files'],
      additionalProperties: true,
    },
    caps: READONLY_CAPS,
    idempotent: true,
    render: {
      form: 'card',
      label: 'plugin',
      summary: 'validate  {identity}',
      tone: 'solid',
      detail: { kind: 'json' },
    },
  },
  {
    name: 'plugin.write',
    intent: '提交候选插件源码改动（须先通过 plugin.validate）。',
    when_to_use: '候选包已通过 plugin.validate、确要推进该插件更新时。',
    param_semantics: {
      identity: '目标插件名，须与候选包内声明一致。',
      files: '候选源码树，须与上一次 plugin.validate 的一致。',
    },
    boundaries: '须先通过 plugin.validate，否则报 validate_required。',
    description: '提交候选插件源码改动。',
    argsSchema: {
      type: 'object',
      properties: { identity: IDENTITY_ARG, files: FILES_ARG },
      required: ['identity', 'files'],
      additionalProperties: true,
    },
    caps: READONLY_CAPS,
    idempotent: false,
    render: {
      form: 'card',
      label: 'plugin',
      summary: 'write  {identity}',
      tone: 'solid',
      detail: { kind: 'diff' },
    },
  },
]

/** `describe` 的输出值（工具清单；模型可见文本由四要素拼装，这里直给 description）。 */
export function describeValue(): Json {
  return { tools: TOOLS }
}
