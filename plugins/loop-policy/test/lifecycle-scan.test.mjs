// I8 静态扫描：生命周期字段只允许在 execute/lifecycle.ts 声明的转换函数（constructor / send）内赋值；
// 其它解释器源不得赋值生命周期字段，也不得内嵌生命周期状态字面量——状态只能经转换表变更。
// 手法与内核静态扫描同：读源码文本、正则累积违规、一次断言为空；注释先剥离，避免文档字样误判。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const EXEC_DIR = join(PKG_ROOT, 'execute')
const LIFECYCLE_FILE = join(EXEC_DIR, 'lifecycle.ts')
const REPO_ROOT = join(PKG_ROOT, '..', '..')

const STATE_LITERALS = ['assembled', 'stepping', 'suspended', 'settling', 'settled']
/** 生命周期状态的赋值点：字段名固定为 `stage`，只允许出现在声明的转换函数内。 */
const ASSIGN_RE = /\.stage\s*=(?!=)/
const STATE_CONTEXT_RE = new RegExp(
  `(?:state|stage)\\s*(?:===?|!==?|[:=])\\s*['"](${STATE_LITERALS.join('|')})['"]`,
  'g',
)

/** 递归收集 execute/ 下 .ts 源（排除生成的 contract/ 子目录）。 */
function executeSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'contract') executeSources(abs, out)
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(abs)
  }
  return out
}

/** 剥离块注释与行注释（行注释跳过 `://`，避免 URL 误伤）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 按大括号配对求函数体区间：声明名 → 若干 {start,end} 偏移。 */
function functionSpans(src, names) {
  const spans = []
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g')
    for (const match of src.matchAll(re)) {
      const brace = src.indexOf('{', match.index + match[0].length)
      if (brace < 0) continue
      let depth = 0
      for (let i = brace; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1
        else if (src[i] === '}') {
          depth -= 1
          if (depth === 0) {
            spans.push({ name, start: match.index, end: i })
            break
          }
        }
      }
    }
  }
  return spans
}

test('I8：生命周期字段只在声明的转换函数内赋值，其它源不含状态字面量', () => {
  const files = executeSources(EXEC_DIR)
  assert.ok(files.length >= 20, `扫描应覆盖全部解释器源，实得 ${files.length}`)

  const lifecycleSrc = stripComments(readFileSync(LIFECYCLE_FILE, 'utf8'))
  const allowed = functionSpans(lifecycleSrc, ['constructor', 'send'])
  const assignments = [...lifecycleSrc.matchAll(new RegExp(ASSIGN_RE.source, 'g'))].map((match) => match.index)
  assert.ok(assignments.length >= 2, 'lifecycle.ts 应含声明的转换赋值（覆盖兜底）')
  for (const index of assignments) {
    assert.ok(
      allowed.some((span) => index >= span.start && index <= span.end),
      `lifecycle.ts 在声明转换函数外赋值生命周期字段 @${index}`,
    )
  }

  const offenders = []
  for (const abs of files) {
    if (abs === LIFECYCLE_FILE) continue
    const repoPath = relative(REPO_ROOT, abs).split('\\').join('/')
    const src = stripComments(readFileSync(abs, 'utf8'))
    for (const line of src.split('\n')) {
      if (ASSIGN_RE.test(line)) offenders.push(`${repoPath}: 赋值生命周期字段 .stage`)
    }
    for (const match of src.matchAll(STATE_CONTEXT_RE)) {
      offenders.push(`${repoPath}: 内嵌生命周期状态字面量 '${match[1]}'`)
    }
  }
  assert.deepEqual(offenders, [])
})
