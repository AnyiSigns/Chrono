// 结构 op 名单三份同源防漂门禁。三份必须逐字一致，任何一份增删 op
// 都要三处同改，否则本门禁失败并指出漂移侧：
//   A. `packages/kernel/types.ts` 的 `Op` 类型联合——纯类型、不可 import，按源码扫描；
//   B. `packages/kernel/commit.ts` 的运行期 `VALID_OPS`——未导出，按源码扫描；
//   C. `packages/host/common/op-names.ts` 的宿主镜像 `OP_NAMES`——导出值，直接运行时 import。
// 比对含顺序：`VALID_OPS` 的 split 串顺序被索引 / 校验依赖，顺序漂移同样判失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OP_NAMES } from '../../packages/host/common/op-names.ts'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 从 `Op` 类型联合中按出现顺序抽取 op 字面量。 */
function parseTypeOps(src) {
  const start = src.indexOf('export type Op =')
  assert.notEqual(start, -1, 'types.ts 中找不到 `export type Op =`')
  const rest = src.slice(start + 'export type Op ='.length)
  const end = rest.search(/\nexport (interface|type)\b/)
  const body = end === -1 ? rest : rest.slice(0, end)
  return [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
}

/** 从运行期 `VALID_OPS` 的 `Object.freeze('a b c'.split(' '))` 串中抽取 op 名。 */
function parseValidOps(src) {
  const match = src.match(
    /VALID_OPS[\s\S]*?Object\.freeze\(\s*'([^']+)'\s*\.split\(\s*' '\s*\)/,
  )
  assert.notEqual(match, null, 'commit.ts 中找不到 VALID_OPS 的 split 串')
  return match[1].split(' ').filter((name) => name.length > 0)
}

test('结构 op 名单三份逐字一致（types.Op / commit.VALID_OPS / host.OP_NAMES）', () => {
  const sources = {
    'packages/kernel/types.ts': parseTypeOps(read('packages/kernel/types.ts')),
    'packages/kernel/commit.ts': parseValidOps(read('packages/kernel/commit.ts')),
    'packages/host/common/op-names.ts': [...OP_NAMES],
  }
  // 覆盖兜底：三份都确实解析出足量 op，防正则失配导致空转比对。
  for (const [file, ops] of Object.entries(sources)) {
    assert.ok(ops.length >= 10, `${file} 解析出的 op 过少（${ops.length}），疑似解析失配`)
  }
  const canonical = sources['packages/host/common/op-names.ts']
  assert.equal(new Set(canonical).size, canonical.length, 'OP_NAMES 自身含重复 op')
  const drifted = Object.entries(sources)
    .filter(([, ops]) => JSON.stringify(ops) !== JSON.stringify(canonical))
    .map(([file, ops]) => `${file} = [${ops.join(', ')}]`)
  assert.equal(
    drifted.length,
    0,
    `结构 op 名单漂移（基准 packages/host/common/op-names.ts = [${canonical.join(', ')}]）：\n${drifted.join('\n')}`,
  )
})
