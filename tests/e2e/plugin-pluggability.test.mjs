// 加成开放验收：把一个 `context-source` 提供方加入世界 → 上下文生效（经 graph-run 的
// `context.assemble` 前置 `collect` 扇出），且 `context-window` / `chat` / `graph-run` 文件逐字节不变。
// 复用 capability-needs 的「声明逐字节不变」断言方式；缺原生 tokenizer 产物时转 skip。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootScenario,
  computeWorldIdentities,
  externPayloads,
  fixturePluginDir,
  NativeTokenizerMissing,
} from '../harness/index.mjs'
import { REPO_ROOT } from '../harness/closure.mjs'

const SOURCE = 'ctxsource-fixture'

/** 核心装配器 / 消费方文件：新增来源不得要求改动它们。 */
const CORE_FILES = [
  join(REPO_ROOT, 'plugins', 'context-window', 'execute', 'candidates.ts'),
  join(REPO_ROOT, 'plugins', 'context-window', 'execute', 'pipeline.ts'),
  join(REPO_ROOT, 'plugins', 'context-window', 'execute', 'budget.ts'),
  join(REPO_ROOT, 'plugins', 'graph-run', 'execute', 'dispatch.ts'),
  join(REPO_ROOT, 'plugins', 'chat', 'execute', 'assemble.ts'),
]

async function withScenario(t, options, fn) {
  let scenario
  try {
    scenario = await bootScenario(options)
  } catch (err) {
    if (err instanceof NativeTokenizerMissing) {
      t.skip('缺少 context-window 原生 tokenizer 产物，跳过真实回合')
      return
    }
    throw err
  }
  try {
    // 本机若 Rust/toy 服务未能装载（workspace 缺席），整条 chat 链路无法起回合——
    // 与原生 tokenizer 缺失同口径 skip；这与本用例要验的插槽开放性无关。
    if (!scenario.world.loaded.includes('workspace')) {
      t.skip('世界未装载 workspace 服务（Rust/toy 构件缺失），跳过完整链路端到端')
      return
    }
    await fn(scenario)
  } finally {
    await scenario.dispose()
  }
}

test('新增 context-source 提供方：上下文生效，核心文件逐字节不变', async (t) => {
  const before = CORE_FILES.map((path) => readFileSync(path, 'utf8'))
  await withScenario(
    t,
    {
      defaultText: 'ok',
      closure: [...computeWorldIdentities('chat'), SOURCE],
      overrides: { [SOURCE]: fixturePluginDir(SOURCE) },
    },
    async ({ recorder, stub }) => {
      const { result } = await recorder.sendTurn('你好', { conversationId: 'c-plug' })
      const diag = JSON.stringify(externPayloads(result))
      assert.equal(result.status, 'done', diag)
      // graph-run 前置 `collect` 扇出的贡献经 context-window 组装后到达模型请求。
      const messages = JSON.stringify(stub.requests.map((body) => body?.messages ?? []))
      assert.ok(messages.includes('needle-stable'), `稳定来源须进入模型上下文：${messages} ${diag}`)
      assert.ok(messages.includes('needle-dynamic'), `动态来源须进入模型上下文：${messages} ${diag}`)
    },
  )
  // 加一个来源只改世界成员表：核心插件文件逐字节未动。
  assert.deepEqual(
    CORE_FILES.map((path) => readFileSync(path, 'utf8')),
    before,
  )
})
