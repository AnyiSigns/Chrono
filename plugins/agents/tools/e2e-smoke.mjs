// 三包合并 E2E 冒烟（黑盒，经 boot CLI）：pack → seed → start → 链式写（数据世代）
// → stop → verify / replay。宿主是单写者，verify / replay 持同一把锁，故在 stop 之后执行。
// 用法：node plugins/agents/tools/e2e-smoke.mjs
// 临时根目录建在系统临时目录的 kilo/ 下，执行后可留作排查。
//
// 链式写：条目 def + 新 body（tail 指向条目）+ add_gen 一条原子 batch；批内用 {"$n": k}
// 占位符指向更早的 put；跨批续链用字面 def 哈希写进下一条的 prev。def 哈希 = H({ body })，
// 由内核导出 H 现算（仅测试工具使用；包内运行时代码不 import 内核）。
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { H } from '../../../packages/kernel/index.ts'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')

const PACKAGES = [
  { id: 'agents', dir: join(REPO_ROOT, 'plugins', 'agents') },
  { id: 'skill', dir: join(REPO_ROOT, 'plugins', 'skill') },
  { id: 'evolution', dir: join(REPO_ROOT, 'plugins', 'evolution') },
]

const AT = '2026-09-20T00:00:00.000Z'
const DUMMY_HASH = '0'.repeat(64)

function boot(root, args) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
  const stdout = result.stdout.trim()
  let parsed = null
  if (stdout.length > 0) {
    try {
      parsed = JSON.parse(stdout)
    } catch {
      parsed = null
    }
  }
  if (result.status !== 0) {
    throw new Error(`boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`)
  }
  return parsed
}

/** 提交一条原子 batch 写（expect_pos 锚当前链头）。 */
function submitBatch(root, id, ops, by) {
  const status = boot(root, ['status'])
  const directive = [
    {
      kind: 'write',
      request: {
        id,
        op: 'batch',
        target: { expect_pos: status.world_head.hash },
        args: { ops },
        by,
      },
    },
  ]
  const result = boot(root, ['run', JSON.stringify(directive)])
  assert.equal(result.status, 'done', `批次 ${id} 未完成：${JSON.stringify(result)}`)
  return result
}

function evolutionTrace(run, prev) {
  return {
    kind: 'trace',
    run,
    session: 'c1',
    workspace_id: 'w1',
    graph: DUMMY_HASH,
    steps: [
      {
        node_index: 1,
        iter: 1,
        contract_id: 'agent.step',
        chosen_instance: 'nd-1',
        chosen_agent: null,
        verdict: 'pass',
        refusal: null,
        post_failed: null,
        l1_iters: 1,
        l1_maxed: false,
        verify: null,
        usage: { tokens: 0, calls: 1, tool_calls: 0, walltime_ms: 0 },
        eff_log: [
          {
            step: 0,
            iter: 1,
            port: 'model',
            method: 'chat',
            args_hash: DUMMY_HASH,
            result_hash: DUMMY_HASH,
            outcome: 'ok',
          },
        ],
      },
    ],
    directives_summary: null,
    ctx_summary: null,
    refused_at: null,
    branch_not_taken: 0,
    link_taken: [],
    outcome: 'done',
    at: AT,
    prev,
  }
}

function evolutionBody(tailPlaceholder, count) {
  return {
    version: 1,
    trace: { tail: { def: tailPlaceholder }, count },
    evidence: { tail: null, count: 0 },
    proposals: { tail: null, count: 0 },
    verdicts: { tail: null, count: 0 },
  }
}

function agentInstance(id, name, promptHash, prev) {
  return {
    id,
    name,
    system_prompt: { def: promptHash },
    model: null,
    decoding: null,
    prefer_tools: ['tool-fs.read'],
    scope: { kind: 'global' },
    prev,
  }
}

function agentsBody(tailPlaceholder, count) {
  return {
    version: 1,
    templates: { tail: null, count: 0 },
    instances: { tail: { def: tailPlaceholder }, count },
    channels: { tail: null, count: 0 },
  }
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-data-identities-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    for (const pkg of PACKAGES) {
      const packed = boot(root, ['pack', pkg.dir, '--identity', pkg.id])
      assert.equal(packed.ok, true, `pack ${pkg.id} 报告 ok:false：${JSON.stringify(packed)}`)
      console.log(`pack ${pkg.id}: ${packed.status}`)
    }

    const manifest = PACKAGES.map((pkg) => ({ name: pkg.id, path: pkg.dir }))
    writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify(manifest, null, 2))
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true
    console.log('start: ok')

    // evolution：批 1 起链，批 2 用字面 def 哈希跨批续链。
    const trace1 = evolutionTrace('r-1', null)
    submitBatch(
      root,
      'e2e-evolution-chain-1',
      [
        { op: 'put', args: { body: trace1 } },
        { op: 'put', args: { body: evolutionBody({ $n: 0 }, 1) } },
        { op: 'add_gen', args: { id: 'evolution', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} } },
      ],
      'e2e',
    )
    console.log('evolution chain 1: done')

    const trace1Hash = H({ body: trace1 })
    const trace2 = evolutionTrace('r-2', { def: trace1Hash })
    const trace2Hash = H({ body: trace2 })
    submitBatch(
      root,
      'e2e-evolution-chain-2',
      [
        { op: 'put', args: { body: trace2 } },
        { op: 'put', args: { body: evolutionBody({ $n: 0 }, 2) } },
        { op: 'add_gen', args: { id: 'evolution', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} } },
      ],
      'e2e',
    )
    console.log(`evolution chain 2 (prev=${trace1Hash.slice(0, 12)}…): done`)

    // agents：批 1 写提示词 def + 实例条目 + 索引，批 2 跨批续链。
    const prompt = { text: '你是 Rust 评审员。' }
    const promptHash = H({ body: prompt })
    const instance1 = agentInstance('ag-1', 'Rust 评审员', promptHash, null)
    submitBatch(
      root,
      'e2e-agents-chain-1',
      [
        { op: 'put', args: { body: prompt } },
        { op: 'put', args: { body: instance1 } },
        { op: 'put', args: { body: agentsBody({ $n: 1 }, 1) } },
        { op: 'add_gen', args: { id: 'agents', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} } },
      ],
      'e2e',
    )
    console.log('agents chain 1: done')

    const instance1Hash = H({ body: instance1 })
    const instance2 = agentInstance('ag-2', 'Python 评审员', promptHash, { def: instance1Hash })
    const instance2Hash = H({ body: instance2 })
    submitBatch(
      root,
      'e2e-agents-chain-2',
      [
        { op: 'put', args: { body: instance2 } },
        { op: 'put', args: { body: agentsBody({ $n: 0 }, 2) } },
        { op: 'add_gen', args: { id: 'agents', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} } },
      ],
      'e2e',
    )
    console.log(`agents chain 2 (prev=${instance1Hash.slice(0, 12)}…): done`)

    // skill：内联列表，整 body 直写。
    const skillBody = {
      version: 1,
      skills: [
        {
          id: 'sk-1',
          name: '写测试',
          description: '为改动补单元测试的步骤与约定',
          triggers: {
            keywords: ['测试', 'test', '单测'],
            file_globs: ['**/*.test.ts', 'tests/**'],
            explicit: ['@测试'],
          },
          scope: { kind: 'global' },
          body: '先读改动，再补最接近的测试用例。',
          enabled: true,
          at: AT,
        },
      ],
    }
    submitBatch(
      root,
      'e2e-skill-body',
      [
        { op: 'put', args: { body: skillBody } },
        { op: 'add_gen', args: { id: 'skill', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
      ],
      'e2e',
    )
    console.log('skill body: done')

    boot(root, ['stop'])
    started = false
    console.log('stop: ok')

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    console.log(`verify: ok (head seq=${verified.head.seq})`)

    const replayed = boot(root, ['replay'])
    assert.equal(typeof replayed.worldRev, 'string')
    assert.equal(replayed.worldRev.length, 64)
    console.log(`replay: ok (worldRev=${replayed.worldRev.slice(0, 12)}…)`)

    // 停机后离线读投影：链头 tail 指向最新条目、refs 闭包含全链（跨批续链的关键断言）。
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)

    const evolutionBodyRead = projection.ids.evolution.body
    assert.equal(evolutionBodyRead.trace.count, 2)
    assert.equal(evolutionBodyRead.trace.tail.def, H({ body: trace2 }))
    assert.ok(projection.ids.evolution.refs[trace1Hash], 'evolution refs 缺 trace 1')
    assert.ok(projection.ids.evolution.refs[trace2Hash], 'evolution refs 缺 trace 2')

    const agentsBodyRead = projection.ids.agents.body
    assert.equal(agentsBodyRead.instances.count, 2)
    assert.equal(agentsBodyRead.instances.tail.def, H({ body: instance2 }))
    assert.ok(projection.ids.agents.refs[instance1Hash], 'agents refs 缺 instance 1')
    assert.ok(projection.ids.agents.refs[instance2Hash], 'agents refs 缺 instance 2')
    assert.ok(projection.ids.agents.refs[promptHash], 'agents refs 缺提示词 def')

    const skillBodyRead = projection.ids.skill.body
    assert.equal(skillBodyRead.skills.length, 1)
    assert.equal(skillBodyRead.skills[0].triggers.explicit[0], '@测试')
    console.log('projection: ok（tail 指向 + refs 闭包含全链）')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'])
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
  }
}

main()
