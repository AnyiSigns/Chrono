// 资产内联测试（node --test）：上下文投影产出的资产占位符在发请求前被换成内联字节，
// 取字节失败 / 缺失 / 不受支持的协议形态降级为文本引用，绝不剩 `asset:<sha>` 占位符。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAssets } from '../execute/assets.ts'

const SHA = 'a'.repeat(64)
const PNG = { mime: 'image/png', bytes: 'aGVsbG8=' }

/** 取字节桩：记录调用次数，缺省回 PNG。 */
function fetcher(value = PNG) {
  const calls = []
  const fetchAsset = async (sha256) => {
    calls.push(sha256)
    return value
  }
  fetchAsset.calls = calls
  return fetchAsset
}

test('openai-chat：image_url 占位符 → data URL', async () => {
  const fetch = fetcher()
  const out = await resolveAssets(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: `asset:${SHA}` } },
        ],
      },
    ],
    'openai-chat',
    fetch,
  )
  assert.deepEqual(out[0].content[1], {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${PNG.bytes}` },
  })
  assert.deepEqual(fetch.calls, [SHA])
})

test('openai-responses：input_image 字符串占位符 → data URL', async () => {
  const fetch = fetcher()
  const out = await resolveAssets(
    [{ role: 'user', content: [{ type: 'input_image', image_url: `asset:${SHA}` }] }],
    'openai-responses',
    fetch,
  )
  assert.deepEqual(out[0].content[0], {
    type: 'input_image',
    image_url: `data:image/png;base64,${PNG.bytes}`,
  })
})

test('anthropic-messages：{type:asset} 源 → base64 块', async () => {
  const fetch = fetcher()
  const out = await resolveAssets(
    [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'asset', sha256: SHA, mime: 'image/png' } }],
      },
    ],
    'anthropic-messages',
    fetch,
  )
  assert.deepEqual(out[0].content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG.bytes },
  })
})

test('取字节失败：降级文本引用，不整轮失败', async () => {
  const fetch = fetcher(null)
  const out = await resolveAssets(
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `asset:${SHA}` } }] }],
    'openai-chat',
    fetch,
  )
  assert.equal(out[0].content[0].type, 'text')
  assert.ok(out[0].content[0].text.includes('image'))
  assert.ok(!JSON.stringify(out).includes(`asset:${SHA}`), '不得残留占位符')
})

test('openai-chat：file 降级文本；audio 编成 input_audio', async () => {
  const file = await resolveAssets(
    [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: { asset: { sha256: SHA, mime: 'application/pdf' }, name: 'a.pdf' },
          },
        ],
      },
    ],
    'openai-chat',
    fetcher(),
  )
  assert.equal(file[0].content[0].type, 'text')

  const audio = await resolveAssets(
    [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { asset: { sha256: SHA, mime: 'audio/wav' } } },
        ],
      },
    ],
    'openai-chat',
    fetcher({ mime: 'audio/wav', bytes: 'UklGRg==' }),
  )
  assert.deepEqual(audio[0].content[0], {
    type: 'input_audio',
    input_audio: { data: 'UklGRg==', format: 'wav' },
  })
})

test('anthropic：audio 无入参 → 降级文本；openai-responses 用 input_text', async () => {
  const out = await resolveAssets(
    [
      {
        role: 'user',
        content: [{ type: 'audio', source: { type: 'asset', sha256: SHA, mime: 'audio/mpeg' } }],
      },
    ],
    'anthropic-messages',
    fetcher(),
  )
  assert.equal(out[0].content[0].type, 'text')

  const responses = await resolveAssets(
    [{ role: 'user', content: [{ type: 'input_image', image_url: `asset:${SHA}` }] }],
    'openai-responses',
    fetcher(null),
  )
  assert.equal(responses[0].content[0].type, 'input_text')
})

test('非资产 URL 原样保留；同 sha 只取一次', async () => {
  const fetch = fetcher()
  const out = await resolveAssets(
    [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `asset:${SHA}` } },
          { type: 'image_url', image_url: { url: `asset:${SHA}` } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ],
    'openai-chat',
    fetch,
  )
  assert.equal(out[0].content[2].image_url.url, 'https://example.com/a.png')
  assert.deepEqual(fetch.calls, [SHA])
})

test('纯文本消息原样返回（不触取字节）', async () => {
  const fetch = fetcher()
  const messages = [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
  ]
  const out = await resolveAssets(messages, 'openai-chat', fetch)
  assert.deepEqual(out, messages)
  assert.deepEqual(fetch.calls, [])
})
