// `context-source` 扩展类（many）：外部中性记录随 bag.context_sources 传入，机械进候选；
// 缺省 / 空表合法；非法记录静默跳过，不崩装配。

import test from 'node:test'
import assert from 'node:assert/strict'
import { baseBag, startService } from './driver.mjs'

async function buildWith(bag) {
  const service = startService()
  try {
    await service.hello()
    return await service.build(bag)
  } finally {
    service.close()
    await service.exit
  }
}

test('外部稳定 / 动态记录进入消息列，并在 manifest.sources 按需开桶', async () => {
  const value = await buildWith(
    baseBag({
      context_sources: [
        {
          source: 'fixture-memory',
          role: 'system',
          parts: [{ type: 'text', text: '[mem] needle-stable' }],
          priority: 0,
          stability: 'stable',
        },
        {
          source: 'fixture-retrieval',
          role: 'system',
          parts: [{ type: 'text', text: '[retrieval] needle-dynamic' }],
          priority: 4,
          stability: 'dynamic',
        },
      ],
    }),
  )
  assert.equal(value.ok, true, JSON.stringify(value))
  const text = JSON.stringify(value.messages)
  assert.ok(text.includes('needle-stable'))
  assert.ok(text.includes('needle-dynamic'))
  assert.equal(value.manifest.sources['fixture-memory'].count, 1)
  assert.equal(value.manifest.sources['fixture-retrieval'].count, 1)
})

test('缺省 / 空 context_sources：装配照常，无外部来源', async () => {
  const value = await buildWith(baseBag({ context_sources: [] }))
  assert.equal(value.ok, true, JSON.stringify(value))
  assert.equal(Object.hasOwn(value.manifest.sources, 'fixture-memory'), false)
})

test('非法记录作数据跳过，不崩装配', async () => {
  const value = await buildWith(
    baseBag({
      context_sources: [
        { source: '', role: 'system', parts: [{ type: 'text', text: 'x' }], priority: 0, stability: 'stable' },
        { source: 'ok', role: 'nope', parts: [], priority: 0, stability: 'stable' },
        {
          source: 'fixture-good',
          role: 'system',
          parts: [{ type: 'text', text: 'needle-good' }],
          priority: 0,
          stability: 'stable',
        },
      ],
    }),
  )
  assert.equal(value.ok, true, JSON.stringify(value))
  assert.ok(JSON.stringify(value.messages).includes('needle-good'))
  assert.equal(value.manifest.sources['fixture-good'].count, 1)
})
