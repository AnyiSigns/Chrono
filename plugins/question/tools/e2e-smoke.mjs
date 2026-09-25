// `question` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读）：
// 临时 root → state/plugins.json 列 question → seed → start → 轮询 loaded → 经宿主跑一次命令 question.answer
// （无槽，预期结构化 no_slot、不写世界、run 正常 done）→ stop → verify + replay → 离线读投影核对身份与世代。
//
// 说明：作答续跑的另一半（eval chat.resume + 记答案 + 清槽）需要 #14 chat / #33 loop-policy 与 #1 input 就位，
// 不在 W3 装配内；该路径由协议级测试以真实服务调用 + kernel `eval` 求值入口 term 覆盖。
// 用法：node plugins/question/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const QUESTION_DIR = join(REPO_ROOT, 'plugins', 'question')

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

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-question-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'question', path: QUESTION_DIR },
        { name: 'input', path: join(REPO_ROOT, 'plugins', 'input') },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'])
      return status.loaded.some((item) => item.id === 'question')
    }, 'question loaded')
    console.log('start + 握手：ok（question 已装载）')

    const status = boot(root, ['status'])
    const loaded = status.loaded.find((item) => item.id === 'question')
    assert.match(loaded.gen, /^[0-9a-f]{64}$/, 'question 应有 active 代码世代')

    // 声明：命令清单里应有 question.answer（入口 term 解析通过）
    const commands = boot(root, ['commands'])
    const list = Array.isArray(commands) ? commands : (commands?.commands ?? [])
    const names = list.map((item) => item.name)
    assert.ok(names.includes('question.answer'), `命令清单缺 question.answer：${JSON.stringify(commands)}`)
    console.log('命令声明：question.answer 在册')

    // 经宿主跑一次命令：无槽 → 结构化 no_slot，不写世界，run 正常 done
    const answered = boot(root, ['question.answer'])
    assert.ok(answered !== null, 'question.answer 应回结果')
    assert.equal(answered.status, 'done', `无槽作答应以 done 收口：${JSON.stringify(answered)}`)
    console.log('命令 run：question.answer（无槽）→ done（结构化 no_slot，不写世界）')

    // 命令 run 会落效果审计 def，链头随之推进；比对链头须用命令后的状态
    const finalStatus = boot(root, ['status'])
    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, finalStatus.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head, { blobsDir: paths.blobsDir })
    const question = projection.ids['question']
    assert.ok(question, '投影缺 question')
    assert.deepEqual(question.pins, { input: 'input' }, 'question pin input（作答槽 owner）')
    assert.ok(question.gens.length >= 1, 'question 应有代码世代')
    console.log('离线投影：身份与世代正确、pins 指向 input')

    console.log(`E2E ok（root=${root}）`)
    console.log('注：作答续跑（chat.resume / 记答案 / 清槽）依赖 #14/#33/#1，见文件头说明。')
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

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
