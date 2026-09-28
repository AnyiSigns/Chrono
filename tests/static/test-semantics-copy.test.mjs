// 冻结层语义副本扫描：插件的 `test/` 不得就地重新实现内核 / 宿主的冻结语义。
//
// 规则：以下名字代表冻结层已实现的语义，插件测试里出现同名的本地函数声明即违规——
//   substitute     批内 `$n` 占位符替换（内核）
//   resolveBatch   按内核 argsHash 口径解析一批 ops（内核）
//   batchDigest    batch 两段式摘要（内核）
//   hashOnly       单个 op 的 argsHash（内核）
//   applyBatch     batch 应用（内核）
//   assembleBody   补丁组装（内核）
//   readPatchOps   补丁 def body 读口（内核）
//   assemblePatch  补丁组装（宿主投影）
//   assembleGenBody 世代 body 组装（宿主投影）
//   assembleEvolutionBatch 世代补丁组装（宿主投影）
//
// 理由：副本不会随冻结层换代而失败，只会静默漂移；需要这些语义的断言属跨层测试，
// 应落根 `tests/contract/` 并 import 真实的 `packages/kernel` / `packages/host`。
// 扫描只比对本地函数声明名，不做数据流分析；命中即要求作者改用真实实现或移出插件测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DENY = new Set([
  'substitute',
  'resolveBatch',
  'batchDigest',
  'hashOnly',
  'applyBatch',
  'assembleBody',
  'readPatchOps',
  'assemblePatch',
  'assembleGenBody',
  'assembleEvolutionBatch',
])
const JS_EXT = /\.(mjs|cjs|js|ts|tsx|mts|cts)$/
const DECL_RE =
  /(?:^|[\s;])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|[\s;])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/

function collectTestFiles(dir, out, inTest) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectTestFiles(abs, out, inTest || entry.name === 'test')
    } else if (inTest && JS_EXT.test(entry.name)) {
      out.push(abs)
    }
  }
  return out
}

test('冻结层语义副本：插件 test/ 不得本地重定义内核 / 宿主语义函数', () => {
  const offenders = []
  const root = join(ROOT, 'plugins')
  const files = collectTestFiles(root, [], false)
  for (const abs of files) {
    const repoPath = relative(ROOT, abs).split('\\').join('/')
    const lines = readFileSync(abs, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const match = DECL_RE.exec(lines[i])
      const name = match === null ? null : match[1] ?? match[2]
      if (name !== null && DENY.has(name)) offenders.push(`${repoPath}:${i + 1} ${name}`)
    }
  }
  assert.deepEqual(offenders, [])
  assert.ok(files.length >= 100, `expected >= 100 plugin test files, got ${files.length}`)
})
