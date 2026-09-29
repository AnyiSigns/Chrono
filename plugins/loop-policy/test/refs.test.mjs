// 引用水合（ref-hydrate）契约：bag 内 refs 经反向 `ref-hydrate.hydrate` 解析；
// 提供方不可用（def_unavailable / denied / 传输失败）一律 fail-closed，帧码保持 `def_unavailable`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

const HASH_A = 'a'.repeat(64)

test('服务调用：ref-hydrate 回不可用 → def_unavailable 错误帧（非 internal）', async () => {
  const service = startService({
    providers: {
      'ref-hydrate.hydrate': () => ({
        __error: { code: 'def_unavailable', message: `def unavailable: ${HASH_A}` },
      }),
    },
  })
  try {
    const result = await service.interpret({
      evolution: {
        version: 1,
        trace: { tail: null, count: 0 },
        evidence: { tail: null, count: 0 },
        proposals: { tail: null, count: 0 },
        verdicts: { tail: null, count: 0 },
        refs: [HASH_A],
      },
    })
    assert.equal(result.kind, 'error', JSON.stringify(result))
    assert.equal(result.code, 'def_unavailable')
  } finally {
    service.close()
  }
})

test('服务调用：ref-hydrate 传输失败（denied）→ 同样按拆分前语义映射 def_unavailable', async () => {
  const service = startService({
    providers: {
      'ref-hydrate.hydrate': () => ({ __error: { code: 'denied', message: 'denied' } }),
    },
  })
  try {
    const result = await service.interpret({
      evolution: {
        version: 1,
        trace: { tail: null, count: 0 },
        evidence: { tail: null, count: 0 },
        proposals: { tail: null, count: 0 },
        verdicts: { tail: null, count: 0 },
        refs: [HASH_A],
      },
    })
    assert.equal(result.kind, 'error', JSON.stringify(result))
    assert.equal(result.code, 'def_unavailable')
  } finally {
    service.close()
  }
})

test('服务调用：ref-hydrate 取回闭包 → 回合照常收口（不拒）', async () => {
  const service = startService({
    providers: {
      'ref-hydrate.hydrate': (args) =>
        args.identity === 'evolution'
          ? {
              [HASH_A]: {
                version: 1,
                trace: { tail: null, count: 0 },
                evidence: { tail: null, count: 0 },
                proposals: { tail: null, count: 0 },
                verdicts: { tail: null, count: 0 },
              },
            }
          : {},
    },
  })
  try {
    const result = await service.interpret({
      evolution: {
        version: 1,
        trace: { tail: null, count: 0 },
        evidence: { tail: null, count: 0 },
        proposals: { tail: null, count: 0 },
        verdicts: { tail: null, count: 0 },
        refs: [HASH_A],
      },
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
  } finally {
    service.close()
  }
})
