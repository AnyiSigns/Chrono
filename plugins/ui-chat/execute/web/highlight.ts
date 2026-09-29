// 代码语法高亮薄封装：复用 highlight.js（v11 core）做分词与着色，
// 产物是一段带 `hljs-*` class 的 <span> HTML（内部已转义），再过 markdown 管线的 sanitizeHtml
// （已放行 span + class）。配色由 tokens.v1.css 的 .hljs-* 规则提供，浅 / 深色各一套。
// 只按需注册常用语言，未注册语言回落 highlightAuto（启发式）或纯转义。

import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import powershell from 'highlight.js/lib/languages/powershell'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import ini from 'highlight.js/lib/languages/ini'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import diff from 'highlight.js/lib/languages/diff'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'
import scala from 'highlight.js/lib/languages/scala'
import dart from 'highlight.js/lib/languages/dart'
import lua from 'highlight.js/lib/languages/lua'
import r from 'highlight.js/lib/languages/r'
import plaintext from 'highlight.js/lib/languages/plaintext'

const REGISTRY: { [alias: string]: { name: string; def: any } } = {
  javascript: { name: 'javascript', def: javascript },
  js: { name: 'javascript', def: javascript },
  jsx: { name: 'javascript', def: javascript },
  mjs: { name: 'javascript', def: javascript },
  cjs: { name: 'javascript', def: javascript },
  typescript: { name: 'typescript', def: typescript },
  ts: { name: 'typescript', def: typescript },
  tsx: { name: 'typescript', def: typescript },
  mts: { name: 'typescript', def: typescript },
  python: { name: 'python', def: python },
  py: { name: 'python', def: python },
  bash: { name: 'bash', def: bash },
  sh: { name: 'bash', def: bash },
  shell: { name: 'bash', def: bash },
  zsh: { name: 'bash', def: bash },
  powershell: { name: 'powershell', def: powershell },
  ps1: { name: 'powershell', def: powershell },
  pwsh: { name: 'powershell', def: powershell },
  json: { name: 'json', def: json },
  jsonc: { name: 'json', def: json },
  css: { name: 'css', def: css },
  scss: { name: 'css', def: css },
  less: { name: 'css', def: css },
  html: { name: 'xml', def: xml },
  xml: { name: 'xml', def: xml },
  svg: { name: 'xml', def: xml },
  vue: { name: 'xml', def: xml },
  svelte: { name: 'xml', def: xml },
  astro: { name: 'xml', def: xml },
  sql: { name: 'sql', def: sql },
  mysql: { name: 'sql', def: sql },
  postgres: { name: 'sql', def: sql },
  sqlite: { name: 'sql', def: sql },
  go: { name: 'go', def: go },
  golang: { name: 'go', def: go },
  rust: { name: 'rust', def: rust },
  rs: { name: 'rust', def: rust },
  java: { name: 'java', def: java },
  c: { name: 'c', def: c },
  cpp: { name: 'cpp', def: cpp },
  'c++': { name: 'cpp', def: cpp },
  cc: { name: 'cpp', def: cpp },
  h: { name: 'c', def: c },
  hpp: { name: 'cpp', def: cpp },
  csharp: { name: 'csharp', def: csharp },
  cs: { name: 'csharp', def: csharp },
  yaml: { name: 'yaml', def: yaml },
  yml: { name: 'yaml', def: yaml },
  markdown: { name: 'markdown', def: markdown },
  md: { name: 'markdown', def: markdown },
  ini: { name: 'ini', def: ini },
  conf: { name: 'ini', def: ini },
  toml: { name: 'ini', def: ini },
  dockerfile: { name: 'dockerfile', def: dockerfile },
  diff: { name: 'diff', def: diff },
  ruby: { name: 'ruby', def: ruby },
  rb: { name: 'ruby', def: ruby },
  php: { name: 'php', def: php },
  kotlin: { name: 'kotlin', def: kotlin },
  kt: { name: 'kotlin', def: kotlin },
  swift: { name: 'swift', def: swift },
  scala: { name: 'scala', def: scala },
  dart: { name: 'dart', def: dart },
  lua: { name: 'lua', def: lua },
  r: { name: 'r', def: r },
  text: { name: 'plaintext', def: plaintext },
  txt: { name: 'plaintext', def: plaintext },
  plaintext: { name: 'plaintext', def: plaintext },
  log: { name: 'plaintext', def: plaintext },
}

const registered = new Set<string>()
for (const { name, def } of Object.values(REGISTRY)) {
  if (!registered.has(name)) {
    hljs.registerLanguage(name, def)
    registered.add(name)
  }
}

/** 文本转义（`&` / `<` / `>`）；未知语言回落用。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 高亮代码：按 `lang` 别名选已注册语言交给 highlight.js；未注册语言用 highlightAuto 启发式，
 * 仍无命中则纯转义。返回带 `hljs-*` class 的 <span> HTML（已转义），由调用方包进 <pre><code>。
 */
export function highlightCode(code: string, lang: string): string {
  const key = lang.trim().toLowerCase()
  const entry = REGISTRY[key]
  try {
    if (entry !== undefined) {
      return hljs.highlight(code, { language: entry.name, ignoreIllegals: true }).value
    }
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}
