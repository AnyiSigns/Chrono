// `guard` 数据世代 E2E（黑盒，经 boot CLI + 离线投影读）：
// pack guard → seed → start → seed 脚本写危险规则默认 body（数据世代）→ stop
// → verify + replay 通过 → 离线读投影确认 ids.guard.body = default-body.json。
// 宿主是单写者，任何失败路径都会尝试 stop 释放锁。
// 用法：node plugins/guard/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const GUARD_DIR = join(REPO_ROOT, 'plugins', 'guard')
const SEED_SCRIPT = join(GUARD_DIR, 'tools', 'seed-default-body.mjs')
const DEFAULT_BODY = join(GUARD_DIR, 'tools', 'default-body.json')

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

function runSeed(root) {
  const result = spawnSync(process.execPath, [SEED_SCRIPT, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
  if (result.status !== 0) {
    throw new Error(`seed 脚本失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout.trim())
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-guard-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packed = boot(root, ['pack', GUARD_DIR, '--identity', 'guard'])
    assert.equal(packed.ok, true, 'pack guard 报告 ok:false')
    console.log(`pack guard: ${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'guard', path: GUARD_DIR }]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true
    console.log('start + 握手：ok')

    const seededBody = runSeed(root)
    assert.equal(seededBody.ok, true, 'seed 脚本报告 ok:false')
    console.log(`seed 脚本写 guard body：${seededBody.status}`)

    const afterSeed = boot(root, ['status'])
    assert.ok(
      afterSeed.loaded.some((item) => item.id === 'guard'),
      `guard 未装载：${JSON.stringify(afterSeed.loaded)}`,
    )

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, afterSeed.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const expected = JSON.parse(readFileSync(DEFAULT_BODY, 'utf8'))
    assert.deepEqual(projection.ids.guard.body, expected)
    assert.equal(projection.ids.guard.body.danger_patterns.length, 6)
    console.log('离线投影：ids.guard.body = 默认危险规则')

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

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
