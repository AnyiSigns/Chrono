// 能力需求（needs）端到端：真宿主 + 真服务，一消费方按能力类声明 one / many，
// 提供方只声明 implements；成员集随世界增减、退役静默缺席、休眠呈元素错误，消费方零改动。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootWorld, fixturePluginDir, lastEvalValue, NativeTokenizerMissing } from '../harness/index.mjs'
import { canonicalJson } from '../../packages/kernel/index.ts'

const CONSUMER = 'capslot-consumer'
const SINGLE = 'capslot-single'
const MANY_A = 'capslot-many-a'
const MANY_B = 'capslot-many-b'
const MANY_C = 'capslot-many-c'
const MANY_DOWN = 'capslot-many-down'

const CONSUMER_PLUGIN_JSON = join(fixturePluginDir(CONSUMER), 'plugin.json')

/** 只播种子 + 起宿主的场景；缺原生 tokenizer 产物时由 harness 抛错，转 skip。 */
async function withWorld(t, ids, options, fn) {
  let world
  try {
    world = await bootWorld({
      closure: ids,
      overrides: Object.fromEntries(ids.map((id) => [id, fixturePluginDir(id)])),
      ...options,
    })
  } catch (err) {
    if (err instanceof NativeTokenizerMissing) {
      t.skip('缺少 context-window 原生 tokenizer 产物，跳过端到端')
      return
    }
    throw err
  }
  try {
    const client = await world.connect()
    try {
      await fn({ client, world })
    } finally {
      client.close()
    }
  } finally {
    await world.dispose()
  }
}

/** many 槽聚合值：恒为元素表（判别键 `ok` 恒存在）。 */
async function collectMany(client, tag) {
  const value = lastEvalValue(await client.command('capslot.collect-many', { tag }))
  assert.ok(Array.isArray(value), `many 槽聚合应为元素表：${JSON.stringify(value)}`)
  return value
}

/** 运行期退役身份：`set_active(null)`，世界层移除、不入能力索引。 */
async function retire(client, id) {
  const status = await client.status()
  const result = await client.submit([
    {
      kind: 'write',
      request: {
        id: `e2e-retire-${id}`,
        op: 'set_active',
        target: { expect_pos: status.world_head.hash },
        args: { id, active: null },
        by: 'e2e',
      },
    },
  ])
  assert.equal(result.status, 'done', `退役 ${id} 失败：${JSON.stringify(result)}`)
}

test('one 槽单值流入、many 槽有序元素表；同世界同返回聚合 canonicalJson 相同', async (t) => {
  await withWorld(t, [CONSUMER, SINGLE, MANY_A, MANY_B], {}, async ({ client }) => {
    // one：入世期解析到唯一提供方，值原样流回。
    const single = lastEvalValue(await client.command('capslot.echo-one', { tag: 'one' }))
    assert.equal(single.from, SINGLE)
    assert.equal(single.method, 'get')

    // many：成员按提供方身份名字典序，逐元素 `{provider, ok, value}`。
    const table = await collectMany(client, 'many')
    assert.deepEqual(
      table.map((element) => element.provider),
      [MANY_A, MANY_B],
    )
    for (const element of table) {
      assert.equal(element.ok, true)
      assert.equal(element.value.from, element.provider)
    }

    // 确定性：同世界 + 同提供方返回 ⇒ 聚合逐字节同一。
    const first = await collectMany(client, 'stable')
    const second = await collectMany(client, 'stable')
    assert.equal(canonicalJson(first), canonicalJson(second))
  })
})

test('加第三个 many 提供方：消费方声明不变、成员集增长、聚合随之变化', async (t) => {
  const declared = readFileSync(CONSUMER_PLUGIN_JSON, 'utf8')
  await withWorld(t, [CONSUMER, SINGLE, MANY_A, MANY_B, MANY_C], {}, async ({ client }) => {
    const table = await collectMany(client, 'many')
    assert.deepEqual(
      table.map((element) => element.provider),
      [MANY_A, MANY_B, MANY_C],
    )
    // 成员增长只来自世界提供方集合；消费方声明文件逐字节未动。
    assert.equal(readFileSync(CONSUMER_PLUGIN_JSON, 'utf8'), declared)
  })
})

test('运行期退役 many 提供方：静默缺席、聚合仍 ok；清零后空表', async (t) => {
  await withWorld(t, [CONSUMER, SINGLE, MANY_A, MANY_B], {}, async ({ client }) => {
    assert.deepEqual(
      (await collectMany(client, 'x')).map((element) => element.provider),
      [MANY_A, MANY_B],
    )

    await retire(client, MANY_B)
    // 退役者不入能力索引 ⇒ 不出现为成员、也不作元素错误。
    const afterRetire = await collectMany(client, 'x')
    assert.deepEqual(
      afterRetire.map((element) => element.provider),
      [MANY_A],
    )

    // 提供方退役不连坐消费方：消费方其余能力调用照常可用。
    const single = lastEvalValue(await client.command('capslot.echo-one', { tag: 'one' }))
    assert.equal(single.from, SINGLE)

    await retire(client, MANY_A)
    assert.deepEqual(await collectMany(client, 'x'), [])
  })
})

test('休眠 many 提供方：仍为成员、呈元素错误 not_loaded，聚合仍 ok', async (t) => {
  await withWorld(
    t,
    [CONSUMER, SINGLE, MANY_A],
    { extraPlugins: [{ name: MANY_DOWN, path: fixturePluginDir(MANY_DOWN) }] },
    async ({ client }) => {
      // 休眠 = 服务起不来但世界声明在：仍入索引作成员，端点行缺失作该元素错误。
      const table = await collectMany(client, 'down')
      assert.deepEqual(
        table.map((element) => element.provider),
        [MANY_A, MANY_DOWN],
      )
      const active = table.find((element) => element.provider === MANY_A)
      assert.equal(active.ok, true)
      const sleeping = table.find((element) => element.provider === MANY_DOWN)
      assert.equal(sleeping.ok, false)
      assert.equal(sleeping.error, 'not_loaded')
    },
  )
})
