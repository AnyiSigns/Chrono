// `title-format` 服务协议级测试：spawn `node execute/main.ts`。
// 覆盖：握手 / 控制 / EOF 自退出；clean 去引号标点 + 码点截断；fallback 前 N 字；
// resolve 兜底顺序；args 缺字段 / 非法的结构化拒；无反向调用、无事件、无写计划。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** SDK 驱动适配：能力类固定，本服务无反向调用。 */
function drive() {
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT })
  return {
    ...drv,
    hello: () => drv.hello('title-format'),
    call: (method, args, env = FIXED_ENV) => drv.call('title-format', method, args, env),
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'title-format')
    assert.deepEqual(manifest.implements, ['title-format'])
    assert.deepEqual(manifest.methods['title-format'], ['clean', 'fallback', 'resolve'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('clean：取首个非空行、去引号与结尾标点、按码点截断', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal(
      (await drv.call('clean', { text: '"快速排序算法。"', max_chars: 10 })).value.title,
      '快速排序算法',
    )
    assert.equal(
      (
        await drv.call('clean', {
          text: '\n\n  快速排序。  \n第二行',
          max_chars: 10,
        })
      ).value.title,
      '快速排序',
    )
    assert.equal(
      (
        await drv.call('clean', {
          text: '这是一个非常长的人工智能生成标题需要截断',
          max_chars: 10,
        })
      ).value.title,
      '这是一个非常长的人工',
    )
    assert.equal(drv.portCalls.length, 0, '纯函数面不应有反向调用')
    assert.equal(drv.events.length, 0)
  } finally {
    drv.close()
  }
})

test('fallback：首条消息折叠空白后前 N 字', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('fallback', {
      first_message: '  帮我写一个快速排序算法  ',
      max_chars: 10,
    })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.title, '帮我写一个快速排序算')
  } finally {
    drv.close()
  }
})

test('resolve：模型清理结果 → 首条消息前 N 字 → 缺省标题', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const model = await drv.call('resolve', {
      model_text: '"快速排序算法。"',
      first_message: '帮我写一个快速排序算法',
      max_chars: 10,
      title_default: '新对话',
    })
    assert.equal(model.value.title, '快速排序算法')

    const fallback = await drv.call('resolve', {
      model_text: '',
      first_message: '  帮我写一个快速排序算法  ',
      max_chars: 10,
      title_default: '新对话',
    })
    assert.equal(fallback.value.title, '帮我写一个快速排序算')

    const byDefault = await drv.call('resolve', {
      model_text: null,
      first_message: '   ',
      max_chars: 10,
      title_default: '我的标题',
    })
    assert.equal(byDefault.value.title, '我的标题')
  } finally {
    drv.close()
  }
})

test('args 缺字段 / 非法 → 结构化 bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('clean', { text: 'x' })).code, 'bad_args')
    assert.equal((await drv.call('clean', { text: 'x', max_chars: 0 })).code, 'bad_args')
    assert.equal((await drv.call('fallback', {})).code, 'bad_args')
    assert.equal(
      (
        await drv.call('resolve', {
          first_message: 'x',
          max_chars: 1,
          title_default: 'd',
        })
      ).code,
      'bad_args',
    )
    assert.equal(
      (
        await drv.call('resolve', {
          model_text: 5,
          first_message: 'x',
          max_chars: 1,
          title_default: 'd',
        })
      ).code,
      'bad_args',
    )
    assert.equal((await drv.call('clean', null)).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'title-format', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'clean', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
