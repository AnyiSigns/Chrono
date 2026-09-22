// `orchestration-admin` 宿主装配 E2E（黑盒，经 boot CLI）：
// 临时 root → state/plugins.json 只列 orchestration-admin（无 pins，可独立）→ seed
// → start → 轮询 loaded（握手）→ stop → verify + replay → 离线读投影核对身份 / 空 pins / 世代。
// 另跑一次独立 `pack` 验证单目录入世门禁。
//
// 集成缺口（写明）：宿主只在真实 call 期间路由反向调用，本插件无命令 / 无入口 term，
// 无法在装配运行中从外部触发一次 call；协议级测试已完整覆盖方法行为。本插件无 pins、不发 eff，
// 故不依赖 #33 / #44 / #43。
// 用法：node plugins/orchestration-admin/tools/e2e-smoke.mjs
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
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'orchestration-admin')

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
  const root = join(tmpdir(), 'kilo', `chrono-orchestration-admin-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    // 独立 pack：单目录入世门禁（无 pins，不需其它身份）
    const packRoot = join(tmpdir(), 'kilo', `chrono-orchestration-admin-pack-${stamp}`)
    mkdirSync(join(packRoot, 'state'), { recursive: true })
    const packed = boot(packRoot, ['pack', PLUGIN_DIR, '--identity', 'orchestration-admin'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    assert.equal(packed.identity, 'orchestration-admin')
    console.log(`pack: ${packed.identity}=${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'orchestration-admin', path: PLUGIN_DIR }]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'])
      return status.loaded.some((item) => item.id === 'orchestration-admin')
    }, 'orchestration-admin loaded')
    console.log('start + 握手：ok（orchestration-admin 已装载）')

    const status = boot(root, ['status'])
    const loaded = status.loaded.find((item) => item.id === 'orchestration-admin')
    assert.match(loaded.gen, /^[0-9a-f]{64}$/, 'orchestration-admin 应有 active 代码世代')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    // 离线读投影：身份存在、pins 为空、有代码世代
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const admin = projection.ids['orchestration-admin']
    assert.ok(admin, '投影缺 orchestration-admin')
    assert.deepEqual(admin.pins, {}, 'pins 应为空对象')
    assert.ok(admin.gens.length >= 1, 'orchestration-admin 应有代码世代')
    console.log('离线投影：pins={}、身份与世代正确')

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
