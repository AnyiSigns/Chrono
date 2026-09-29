// `dedup` 纯函数级测试（node --test）：直接 import execute 源码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cosine, dedupNewItems } from '../execute/dedup.ts'
import { normalizeText, uniqueStrings } from '../execute/plan.ts'
import { BackendError, RemoteEmbedding } from '../execute/port-link.ts'

/** 记录反向调用并同步应答的假通道。 */
function fakeLink(responder) {
  const calls = []
  return {
    calls,
    call: async (port, method, args, options) => {
      calls.push({ port, method, args, options })
      return responder(port, method, args)
    },
  }
}

test('normalizeText / uniqueStrings', () => {
  assert.equal(normalizeText('  a   b \n'), 'a b')
  assert.deepEqual(uniqueStrings([' a ', 'a', 'b', '']), ['a', 'b'])
})

test('cosine / dedupNewItems：精确去重与向量去重', async () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  const exact = await dedupNewItems(['a', 'a', 'b'], ['a'], { model: 'm', threshold: 0.9 })
  assert.deepEqual(exact.accepted, ['b'])
  assert.equal(exact.dedup, 'text')

  const embedding = {
    embed: async (texts) =>
      texts.map((text) => (text === 'alpha' || text === 'alpha!' ? [1, 0] : [0, 1])),
  }
  const vector = await dedupNewItems(['alpha!', 'beta'], ['alpha'], {
    embedding,
    model: 'm',
    threshold: 0.9,
  })
  assert.deepEqual(vector.accepted, ['beta'])
  assert.equal(vector.dedup, 'vector')

  const broken = {
    embed: async () => {
      throw new Error('down')
    },
  }
  const fallback = await dedupNewItems(['x'], ['y'], {
    embedding: broken,
    model: 'm',
    threshold: 0.9,
  })
  assert.deepEqual(fallback.accepted, ['x'])
  assert.equal(fallback.dedup, 'text')

  // 候选唯一 + 既有为空 → 不必取向量，直接文本
  const single = await dedupNewItems(['only'], [], { embedding, model: 'm', threshold: 0.9 })
  assert.deepEqual(single.accepted, ['only'])
  assert.equal(single.dedup, 'text')
})

test('RemoteEmbedding：经反向 port.call 调 embedding.embed，带超时', async () => {
  const link = fakeLink(() => ({
    ok: true,
    value: {
      vectors: [
        [1, 0],
        [0, 1],
      ],
    },
  }))
  const backend = new RemoteEmbedding(link)
  const vectors = await backend.embed(['a', 'b'], 'granite-97m')
  assert.deepEqual(vectors, [
    [1, 0],
    [0, 1],
  ])
  assert.equal(link.calls[0].port, 'embedding')
  assert.equal(link.calls[0].method, 'embed')
  assert.ok(link.calls[0].options.timeoutMs > 0)
})

test('RemoteEmbedding：port 失败 / 向量形态坏 → 结构化 BackendError', async () => {
  const failed = new RemoteEmbedding(
    fakeLink(() => ({ ok: false, code: 'embedding_unavailable', message: 'x' })),
  )
  await assert.rejects(
    failed.embed(['a'], 'm'),
    (err) => err instanceof BackendError && err.code === 'embedding_unavailable',
  )

  const bad = new RemoteEmbedding(fakeLink(() => ({ ok: true, value: { vectors: [[1, 'x']] } })))
  await assert.rejects(
    bad.embed(['a'], 'm'),
    (err) => err instanceof BackendError && err.code === 'embedding_bad_result',
  )
})
