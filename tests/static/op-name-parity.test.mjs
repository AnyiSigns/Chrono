// 仓库级静态门禁：结构 op 名三处同源。
// 内核 `packages/kernel/ops.ts` 的 `OP_NAMES` 是单一真源；宿主 `common/op-names.ts` 必须从内核派生
// （不得手写第二份清单）；`kernel/commit.ts` 的 `VALID_OPS` 必须直接取 `OP_NAMES`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function read(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

/** 从 `export const OP_NAMES = [ ... ] as const` 抓出字符串字面量（保持顺序）。 */
function kernelOpNames() {
  const text = read('../../packages/kernel/ops.ts')
  const block = text.match(/OP_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/)
  assert.ok(block, 'kernel/ops.ts 未找到 OP_NAMES 数组')
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('宿主 op-names 从内核派生，不手写第二份清单', () => {
  const text = read('../../packages/host/common/op-names.ts')
  assert.match(text, /from '\.\.\/\.\.\/kernel\/index\.ts'/, 'op-names.ts 必须从内核 index 导入')
  assert.match(text, /new Set\(KERNEL_OP_NAMES\)/, 'op-names.ts 必须由 KERNEL_OP_NAMES 派生')
  assert.doesNotMatch(text, /OP_NAMES\s*=\s*\[\s*'/, 'op-names.ts 不得手写 op 名字面量数组')
})

test('kernel VALID_OPS 直接取 OP_NAMES', () => {
  const text = read('../../packages/kernel/commit.ts')
  assert.match(text, /VALID_OPS[^=]*=\s*OP_NAMES/, 'commit.ts 的 VALID_OPS 必须是 OP_NAMES 的别名')
})

test('OP_NAMES 非空且无重复', () => {
  const names = kernelOpNames()
  assert.ok(names.length > 0)
  assert.equal(new Set(names).size, names.length)
})
