// 工具面自述（`plugin-admin.describe` 的输出）：四个工具 + 描述四要素 + 工具卡 render 描述符。
// 工具名带 `plugin.` 前缀全局唯一；render 形状对齐 plugins/tools/DESIGN.md「工具卡渲染」。
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

const IDENTITY_ARG: Rec = { type: 'string', description: '目标插件身份名（世界里的 id）。' }
const FILES_ARG: Rec = {
  type: 'object',
  description: '候选源码树：包内相对路径 → 文本字符串或 {text}/{base64}。',
}

/** 四个工具的自述（name / 四要素 / argsSchema / caps / idempotent / render）。 */
export const TOOLS: Json[] = [
  {
    name: 'plugin.list',
    intent: '列出世界里的插件身份清单（已按可见性过滤）。',
    when_to_use: '在决定读 / 改哪个插件之前，先看清有哪些身份、各自实现了什么能力与命令。',
    param_semantics: {},
    boundaries:
      '只读清单，不含 pins 明细与源码；可见性黑名单（sandbox 与自身）永远不出现。要看源码用 plugin.read。',
    description:
      '列出可见插件身份（id / active / implements / commands）；sandbox 与 plugin-admin 自身被隐藏。',
    argsSchema: { type: 'object', properties: {}, additionalProperties: true },
    caps: READONLY_CAPS,
    idempotent: true,
    render: { form: 'card', label: 'plugin', summary: 'list', tone: 'solid', detail: { kind: 'list' } },
  },
  {
    name: 'plugin.read',
    intent: '读取某个插件身份的源码文件内容。',
    when_to_use: '需要查看某插件实现、定位要修改的文件时。',
    param_semantics: {
      identity: '目标插件身份名；命中可见性黑名单（sandbox / plugin-admin）一律 hidden_identity。',
      path: '包内相对路径（如 execute/main.ts）；目录或缺失 → not_found。',
    },
    boundaries:
      '只读单文件，不列目录、不返回 tree/blob 结构；隐藏身份不调宿主、直接拒。改源码用 plugin.write。',
    description: '按路径读某插件身份的一个源码文件，返回 base64 内容与字节数。',
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
    intent: '对候选插件包跑宿主入世机械校验 dry-run，返回错误列表与结果哈希。',
    when_to_use: '准备写插件源码之前，先机械校验候选包是否可入世。',
    param_semantics: {
      identity: '候选包的身份名，须与候选 plugin.json.identity 一致；黑名单身份一律 hidden_identity。',
      files: '候选源码树（路径 → 文本 / {text} / {base64}）。',
    },
    boundaries:
      '只校验、不写世界；校验通过的 result_hash 会缓存到宿主 ③，供 plugin.write 机械比对。写用 plugin.write。',
    description: '转发宿主入世校验 dry-run，返回 {ok, errors, result_hash} 并把结果哈希写入 ③ 缓存。',
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
    intent: '为候选插件源码产出世界写计划（不直接写）。',
    when_to_use: '候选包已通过 plugin.validate、且确要推进该身份代码换代时。',
    param_semantics: {
      identity: '目标身份名，须与候选 plugin.json.identity 一致；黑名单身份一律 hidden_identity。',
      files: '候选源码树，须与上一次 plugin.validate 的同一棵树。',
    },
    boundaries:
      '只产写计划，不落账、不审批；缺上一次 validate 的 ③ 凭据 → validate_required。写计划经调用方落账。',
    description: '产出 put(blob/tree/commit) + add_identity?/add_gen 的原子 batch 写计划。',
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
