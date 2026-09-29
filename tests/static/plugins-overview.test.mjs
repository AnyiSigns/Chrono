// 守护 `docs/plugins-overview.md` 与各插件 `plugin.json` 声明不漂：重新渲染整份并逐一比对。
// 该文档为生成物（见 `tools/gen-plugins-overview.mjs`），勿手改。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderOverview } from '../../tools/gen-plugins-overview.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('docs/plugins-overview.md 与 plugin.json 声明一致（生成物不漂）', () => {
  const expected = renderOverview(ROOT)
  const actual = readFileSync(join(ROOT, 'docs', 'plugins-overview.md'), 'utf8')
  assert.equal(
    actual,
    expected,
    'docs/plugins-overview.md 已漂移；请运行 node tools/gen-plugins-overview.mjs 重新生成',
  )
})
