// describe：一次回报本插件暴露的两个工具，四要素齐备，附 argsSchema / caps / idempotent / render。
// 两者都是 GET 类只读操作：idempotent=true，由宿主按 (port, method, canonicalJson(args)) 缓存。

import { defaultCaps, NET_WEBFETCH, NET_WEBSEARCH } from './caps.ts'
import type { Rec } from './types.ts'

const WEBSEARCH_ARGS_SCHEMA: Rec = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: '检索词。' },
    count: { type: 'integer', minimum: 1, description: '返回条数上限。' },
    sources: { type: 'array', items: { type: 'string' }, description: '只查这些源（id 或名字）。' },
    fresh: { type: 'boolean', description: '新鲜度提示（服务无缓存）。' },
  },
}

const WEBFETCH_ARGS_SCHEMA: Rec = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: 'http(s) URL。' },
    format: { enum: ['markdown', 'text', 'raw'], description: 'HTML 输出形态。' },
  },
}

function websearchTool(): Rec {
  return {
    name: 'websearch',
    intent: '在多个免费检索源上并行检索，去重后按名次倒数融合排序返回。',
    when_to_use: '需要从公网检索资料、但手上没有具体 URL 时。',
    param_semantics: {
      query: '检索词，必填、非空。',
      count: '返回条数上限，可选正整数；缺省取配置 top_n。',
      sources: '只查这些源，可选；按源 id 或名字匹配，缺省查全部启用源。',
      fresh: '新鲜度提示，可选布尔；服务无缓存，仅作调用意图标记。',
    },
    boundaries: '只做无状态检索，不抓取正文（改用 webfetch）。',
    description: '在多个免费检索源上并行检索，返回去重合并后的结果列表。',
    argsSchema: WEBSEARCH_ARGS_SCHEMA,
    caps: defaultCaps(NET_WEBSEARCH),
    idempotent: true,
    render: {
      form: 'card',
      label: 'websearch',
      summary: '{query}',
      tone: 'ghost',
      detail: { kind: 'list', fields: ['title', 'url', 'snippet', 'source'] },
      live: false,
    },
  }
}

function webfetchTool(): Rec {
  return {
    name: 'webfetch',
    intent: '抓取单个 http(s) URL，HTML 转 markdown / 纯文本，二进制存为资产引用。',
    when_to_use: '已有具体 URL，需要其正文内容时。',
    param_semantics: {
      url: '要抓取的 http(s) URL，必填；内网地址按配置策略拒绝。',
      format: 'HTML 输出形态，可选：markdown（缺省）/ text / raw。',
    },
    boundaries: '只做无状态抓取，不执行 JS、不持会话；有会话或需渲染的页面改用 webbrowser。',
    description: '抓取单个 http(s) URL 的正文内容。',
    argsSchema: WEBFETCH_ARGS_SCHEMA,
    caps: defaultCaps(NET_WEBFETCH),
    idempotent: true,
    render: {
      form: 'card',
      label: 'webfetch',
      summary: '{url}',
      tone: 'ghost',
      detail: { kind: 'code', lang: 'markdown' },
      live: false,
    },
  }
}

/** describe 的返回值：本插件暴露的全部工具。 */
export function describeTools(): Rec {
  return { tools: [websearchTool(), webfetchTool()] }
}
