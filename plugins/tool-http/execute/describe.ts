// describe：一次回报本插件暴露的两个工具，四要素齐备，附 argsSchema / caps / idempotent / render。
// 都是 GET 类只读操作：idempotent=true，由宿主按 (port, method, canonicalJson(args)) 缓存。

import { declaredCaps, NET_WEBFETCH } from './caps.ts'
import type { Rec } from './types.ts'

const WEBSEARCH_ARGS_SCHEMA: Rec = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string' },
    count: { type: 'integer', minimum: 1 },
    sources: { type: 'array', items: { type: 'string' } },
    read: {
      type: 'integer',
      minimum: 0,
      maximum: 5,
    },
    max_chars: {
      type: 'integer',
      minimum: 200,
      maximum: 20000,
    },
  },
}

const WEBFETCH_ARGS_SCHEMA: Rec = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string' },
    format: { enum: ['markdown', 'text', 'raw'] },
  },
}

function websearchTool(): Rec {
  return {
    name: 'websearch',
    intent: '在多个免费检索源上并行检索、去重合并；按需抓取前几条结果的正文。',
    when_to_use: '需要从公网检索资料、手上没有具体 URL 时；需要可直接引用的成段正文时给 read>0。',
    param_semantics: {
      query: '检索词，必填、非空。',
      count: '返回条数上限，可选正整数；缺省取配置 top_n。',
      sources: '只查这些源，可选；按源 id 或名字匹配，缺省查全部启用源。',
      read: '抓取正文的条数，可选 0–5；缺省 0（只检索不读正文），传 1–5 则抓取前 N 条正文。',
      max_chars: '每页正文抽取的字符上限，可选 200–20000（read>0 时生效）；缺省 4000。',
    },
    boundaries:
      '无状态检索与正文抽取（read>0），不执行 JS、不持会话；已知具体 URL 用 webfetch，需渲染 / 交互的页面用 webbrowser。',
    description: '在多个免费检索源上并行检索，返回去重合并后的结果；read>0 时附前几条的正文。',
    argsSchema: WEBSEARCH_ARGS_SCHEMA,
    caps: declaredCaps(NET_WEBFETCH),
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
    intent:
      '抓取单个 http(s) URL，HTML 转 markdown 或纯文本（可选保留原始 HTML），二进制存为资产引用。',
    when_to_use: '已有具体 URL，需要其正文内容时。',
    param_semantics: {
      url: '要抓取的 http(s) URL，必填；内网地址按配置策略拒绝。',
      format: 'HTML 输出形态，可选：markdown（缺省）/ text / raw（原始 HTML）。',
    },
    boundaries: '只做无状态抓取，不执行 JS、不持会话；有会话或需渲染的页面改用 webbrowser。',
    description: '抓取单个 http(s) URL 的正文内容。',
    argsSchema: WEBFETCH_ARGS_SCHEMA,
    caps: declaredCaps(NET_WEBFETCH),
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
