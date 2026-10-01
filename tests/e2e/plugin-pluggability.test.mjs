// 加成开放验收：向世界加入扩展提供方 → 经能力插槽生效，且消费方 / 拥有方源码逐字节不变。
//   1) `context-source` 提供方 → 上下文生效（graph-run 前置 `collect` 扇出）。
//   2) `turn-hook` 提供方 → 固定点增量生效（before-assemble）。
//   3) `loop-rule` 判据提供方 → 命名规则生效（term 承载）。
// 复用 capability-needs 的「声明逐字节不变」断言方式；缺原生 tokenizer 产物时转 skip。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootScenario,
  computeWorldIdentities,
  externPayloads,
  fixturePluginDir,
  seedIdentityBody,
  NativeTokenizerMissing,
} from '../harness/index.mjs'
import { REPO_ROOT } from '../harness/closure.mjs'
import { SEED_GRAPH } from '../../plugins/loop-policy/execute/seed.ts'
import { orderNav, recordsOf } from '../../plugins/ui-shell/execute/nav.ts'

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

/** 递归列出目录下全部文件（跳过依赖目录）。 */
function collectFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectFiles(path))
    else out.push(path)
  }
  return out
}

/** 目录树逐字节快照（用于「加提供方不改消费方源码」断言）。 */
function snapshot(dirs) {
  return dirs.map((dir) => collectFiles(dir).map((path) => [path, readFileSync(path, 'utf8')]))
}

const TURN_HOOK_SOURCE = 'turnhook-fixture'
const SESSION_AND_GRAPH_RUN_DIRS = [
  join(REPO_ROOT, 'plugins', 'session'),
  join(REPO_ROOT, 'plugins', 'graph-run'),
]

test('新增 turn-hook 提供方：固定点增量生效，session / graph-run 文件逐字节不变', async (t) => {
  const before = snapshot(SESSION_AND_GRAPH_RUN_DIRS)
  await withScenario(
    t,
    {
      defaultText: 'ok',
      closure: [...computeWorldIdentities('chat'), TURN_HOOK_SOURCE],
      overrides: { [TURN_HOOK_SOURCE]: fixturePluginDir(TURN_HOOK_SOURCE) },
    },
    async ({ recorder, stub }) => {
      const { result } = await recorder.sendTurn('你好', { conversationId: 'c-hook' })
      const diag = JSON.stringify(externPayloads(result))
      assert.equal(result.status, 'done', diag)
      // 夹具在 `before-assemble` 给出的中立 nudge 增量经上下文组装到达模型请求。
      const messages = JSON.stringify(stub.requests.map((body) => body?.messages ?? []))
      assert.ok(messages.includes('needle-hook'), `钩子增量须进入模型上下文：${messages} ${diag}`)
    },
  )
  assert.deepEqual(snapshot(SESSION_AND_GRAPH_RUN_DIRS), before)
})

const LOOP_RULE_SOURCE = 'looprule-fixture'

test('新增 loop-rule 判据提供方：命名规则生效，rules.ts 逐字节不变', async (t) => {
  const rulesPath = join(REPO_ROOT, 'plugins', 'graph-run', 'execute', 'rules.ts')
  const before = readFileSync(rulesPath, 'utf8')
  await withScenario(
    t,
    {
      defaultText: 'ok',
      closure: [...computeWorldIdentities('chat'), LOOP_RULE_SOURCE],
      overrides: { [LOOP_RULE_SOURCE]: fixturePluginDir(LOOP_RULE_SOURCE) },
    },
    async ({ recorder, client }) => {
      // 覆写图使 loop.when 指向夹具判据名：默认提供方 loop-policy 不认领，须由夹具 term 提供。
      await seedIdentityBody(client, 'loop-policy', {
        graph: { ...SEED_GRAPH, loop: { ...SEED_GRAPH.loop, when: 'fixture_loop_never' } },
      })
      const { result } = await recorder.sendTurn('你好', { conversationId: 'c-rule' })
      const diag = JSON.stringify(externPayloads(result))
      assert.equal(result.status, 'done', diag)
    },
  )
  assert.equal(readFileSync(rulesPath, 'utf8'), before)
})

const UI_NAV_SOURCE = 'uinav-fixture'
/** 壳与侧栏文件：新增一个 ui-nav 提供方（页面导航项）不得要求改动它们。 */
const UI_DIRS = [join(REPO_ROOT, 'plugins', 'ui-shell'), join(REPO_ROOT, 'plugins', 'ui-sidebar')]
const UI_SHELL_FILES = [
  join(REPO_ROOT, 'plugins', 'ui-shell', 'execute', 'slots.ts'),
  join(REPO_ROOT, 'plugins', 'ui-shell', 'execute', 'nav.ts'),
  join(REPO_ROOT, 'plugins', 'ui-shell', 'execute', 'web', 'shell.html'),
  join(REPO_ROOT, 'plugins', 'ui-shell', 'execute', 'web', 'lib', 'shell.js'),
  join(REPO_ROOT, 'plugins', 'ui-sidebar', 'execute', 'web', 'entry.tsx'),
]

test('新增 ui-nav 提供方：导航记录经壳确定性汇集，ui-shell / ui-sidebar 文件逐字节不变', async (t) => {
  const before = snapshot(UI_DIRS)
  await withScenario(
    t,
    {
      defaultText: 'ok',
      closure: [...computeWorldIdentities('chat'), UI_NAV_SOURCE],
      overrides: { [UI_NAV_SOURCE]: fixturePluginDir(UI_NAV_SOURCE) },
    },
    async () => {
      // 提供方的中立记录经壳的汇集 / 排序器消费（页面 target）；本环境不启壳 HTTP，只验记录可被壳机械消费。
      const groups = [
        {
          provider: UI_NAV_SOURCE,
          records: recordsOf({
            records: [{ id: 'fixture-page', label: '夹具页', icon: 'folder', target: { page: 'fixture-page' }, order: 1 }],
          }),
        },
      ]
      const ordered = orderNav(groups)
      assert.deepEqual(ordered.map((record) => record.id), ['fixture-page'])
      assert.deepEqual(ordered[0].target, { page: 'fixture-page' })
      assert.equal(ordered[0].provider, UI_NAV_SOURCE)
    },
  )
  // 加一个导航提供方只改世界成员表：壳 / 侧栏实现文件逐字节未动。
  assert.deepEqual(snapshot(UI_DIRS), before)
  for (const path of UI_SHELL_FILES) assert.equal(existsSync(path), true, `缺少壳实现文件 ${path}`)
})
