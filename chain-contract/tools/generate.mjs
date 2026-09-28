// 契约运行子集生成器：把 chain-contract/src 派生进各消费插件的 execute/contract/index.ts。
// 生成物自包含（无任何 import），随插件世代入世，也可在浏览器半边运行。
// 生成头带源哈希，供 tools/check-drift.mjs 静态比对。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
export const CONTRACT_DIR = resolve(TOOLS_DIR, '..')
export const SRC_DIR = join(CONTRACT_DIR, 'src')

/** 生成物落点：三个消费插件的 execute/contract/index.ts。 */
export const TARGETS = [
  'plugins/chat/execute/contract/index.ts',
  'plugins/loop-policy/execute/contract/index.ts',
  'plugins/session/execute/contract/index.ts',
]

function sourceFiles() {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
}

/** 源哈希：src/ 下全部 TS 文件的文件名 + 内容，排序后摘要。 */
function computeSourceHash() {
  const hash = createHash('sha256')
  for (const name of sourceFiles()) {
    hash.update(name)
    hash.update('\n')
    hash.update(readFileSync(join(SRC_DIR, name), 'utf8'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

export const SOURCE_HASH = computeSourceHash()

function generatedHeader() {
  return [
    `// @generated: do not edit by hand. source-sha256=${SOURCE_HASH}.`,
    '// Regenerate: node chain-contract/tools/generate.mjs',
    '',
  ].join('\n')
}

function runtimeSource() {
  return readFileSync(join(SRC_DIR, 'runtime.ts'), 'utf8')
}

function withTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 生成全部目标文件的内容（不落盘），键为相对项目根的路径。 */
export function generateAll() {
  const body = withTrailingNewline(runtimeSource())
  const content = generatedHeader() + body
  const outputs = new Map()
  for (const target of TARGETS) outputs.set(target, content)
  return outputs
}

export function writeAll() {
  const outputs = generateAll()
  for (const [target, content] of outputs) {
    const absolute = join(CONTRACT_DIR, '..', target)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return outputs
}

function isDirectRun() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  const self = fileURLToPath(import.meta.url)
  const normalize = (value) => resolve(value).replace(/\\/g, '/').toLowerCase()
  return normalize(invoked) === normalize(self)
}

if (isDirectRun()) {
  const outputs = writeAll()
  const targetExists = [...outputs.keys()].every((target) =>
    existsSync(join(CONTRACT_DIR, '..', target)),
  )
  if (!targetExists) process.exitCode = 1
  process.stdout.write(
    `generated ${outputs.size} contract copies from source-sha256 ${SOURCE_HASH}\n`,
  )
}
