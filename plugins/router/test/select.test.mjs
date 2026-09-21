// `router.select` 纯判定单元测试：直接 import execute 源码，不经服务进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSelect, select } from '../execute/select.ts'
import { BadArgsError } from '../execute/types.ts'

const DEFAULTS = { primary: 'model', aliases: [] }
const run = (args, defaults = DEFAULTS) => select(parseSelect(args, defaults))

test('无别名候选：恒返回主名（机械 no-op）', () => {
  assert.equal(run({ candidates: ['model'], failure: 'model_server_error' }), 'model')
  assert.equal(run({ candidates: ['model', 'other'], failure: 'x' }), 'model')
})

test('aliases 缺省回落 schema 默认空数组', () => {
  const parsed = parseSelect({ candidates: ['model'] }, DEFAULTS)
  assert.deepEqual(parsed.aliases, [])
  assert.equal(parsed.primary, 'model')
  assert.equal(parsed.failure, '')
})

test('有别名候选：取候选清单顺序里第一个被声明的别名', () => {
  const defaults = { primary: 'model', aliases: ['model-alt', 'model-backup'] }
  assert.equal(run({ candidates: ['model', 'model-alt', 'model-backup'] }, defaults), 'model-alt')
  assert.equal(run({ candidates: ['model', 'model-backup', 'model-alt'] }, defaults), 'model-backup')
})

test('别名声明了但不在候选清单：回主名', () => {
  const defaults = { primary: 'model', aliases: ['model-alt'] }
  assert.equal(run({ candidates: ['model'] }, defaults), 'model')
})

test('args 可覆盖 primary / aliases（数据世代 body 随调用传入）', () => {
  assert.equal(run({ candidates: ['primary-x'], primary: 'primary-x' }), 'primary-x')
  assert.equal(run({ candidates: ['model', 'alt'], aliases: ['alt'] }), 'alt')
})

test('返回的端口名必在候选清单内；否则结构化 no_candidate', () => {
  const value = run({ candidates: ['model-alt'], aliases: ['model-alt'] })
  // 有别名候选时选别名，仍在清单内
  assert.equal(value, 'model-alt')
  const missing = run({ candidates: ['model-alt'] }, { primary: 'model', aliases: [] })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'no_candidate')
  assert.match(missing.error.message, /model/)
  assert.match(missing.error.message, /model-alt/)
})

test('纯函数：同输入同输出', () => {
  const args = { candidates: ['model', 'model-alt'], failure: 'e', aliases: ['model-alt'] }
  assert.equal(run(args), run(args))
  assert.equal(run(args), 'model-alt')
})

test('形态非法 → BadArgsError（结构化 bad_args）', () => {
  assert.throws(() => parseSelect({ candidates: [] }, DEFAULTS), BadArgsError)
  assert.throws(() => parseSelect({ candidates: 'model' }, DEFAULTS), BadArgsError)
  assert.throws(() => parseSelect({ candidates: ['model', 1] }, DEFAULTS), BadArgsError)
  assert.throws(() => parseSelect({ candidates: [''] }, DEFAULTS), BadArgsError)
  assert.throws(() => parseSelect({ candidates: ['model'], failure: 1 }, DEFAULTS), BadArgsError)
  assert.throws(() => parseSelect({ candidates: ['model'], primary: '' }, DEFAULTS), BadArgsError)
  assert.throws(() => parseSelect(null, DEFAULTS), BadArgsError)
})
