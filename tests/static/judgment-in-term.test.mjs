// 仓库级静态门禁：保留判定方法名（`judge`/`select`/`verdict`/`gate`/`score`/`rank`）
// 必须由 term 承载（登记进 `plugin.json.judgments`），不得落在服务实现里；且登记的 term 路径必须存在。
// 只约束第一方生产插件目录 `plugins/**`；**本仓库不含生产插件（该目录为空）**，门禁对将来新增的第一方插件生效。
// fixtures 是测试夹具，不受此门禁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RESERVED = ['judge', 'select', 'verdict', 'gate', 'score', 'rank']

function pluginDirs() {
  const dir = join(ROOT, 'plugins')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'plugin.json')))
    .map((entry) => join(dir, entry.name))
}

test('保留判定方法名由 term 承载（登记 judgments）', () => {
  for (const dir of pluginDirs()) {
    const decl = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
    const methods = decl.methods ?? {}
    const judgments = decl.judgments ?? {}
    for (const cap of Object.keys(methods)) {
      for (const method of methods[cap]) {
        if (!RESERVED.includes(method)) continue
        const carried = Object.hasOwn(judgments, cap) && Object.hasOwn(judgments[cap], method)
        assert.ok(carried, `${dir} 的保留方法 ${cap}.${method} 未由 term 承载（缺 judgments 登记）`)
      }
    }
  }
})

test('judgments 登记的 term 路径存在', () => {
  for (const dir of pluginDirs()) {
    const decl = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
    const judgments = decl.judgments ?? {}
    for (const cap of Object.keys(judgments)) {
      for (const method of Object.keys(judgments[cap])) {
        const rel = judgments[cap][method]
        assert.ok(
          existsSync(join(dir, rel)),
          `${dir} 的 judgment ${cap}.${method} 缺 term 文件 ${rel}`,
        )
      }
    }
  }
})
