// `plugin-admin` 宿主装配 E2E（黑盒，经 boot CLI）：
// 临时 root → state/plugins.json 列 plugin-admin + toy-alpha（只读引用 fixture）→ seed
// → start → 轮询 loaded（两身份握手）→ stop → verify + replay → 离线读投影核对 pins/世代。
//
// 集成缺口（写明）：宿主只在**真实 call 期间**路由反向调用（port.call），本插件无命令 / 无入口 term，
// 无法在装配运行中从外部触发一次 call，故本 E2E 不覆盖运行时 port.call 往返——该往返已由协议级测试
// 以「驱动扮演宿主侧应答」完整覆盖；真实 call 路径留给后续波次（#27 派发时会真实走通）。
// 用法：node plugins/plugin-admin/tools/e2e-smoke.mjs
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
const PLUGIN_ADMIN_DIR = join(REPO_ROOT, 'plugins', 'plugin-admin')
const TOY_ALPHA_DIR = join(REPO_ROOT, 'fixtures', 'plugins', 'toy-alpha')

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
  const root = join(tmpdir(), 'kilo', `chrono-plugin-admin-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'plugin-admin', path: PLUGIN_ADMIN_DIR },
        { name: 'toy-alpha', path: TOY_ALPHA_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'])
      return (
        status.loaded.some((item) => item.id === 'plugin-admin') &&
        status.loaded.some((item) => item.id === 'toy-alpha')
      )
    }, 'plugin-admin + toy-alpha loaded')
    console.log('start + 握手：ok（plugin-admin 与 toy-alpha 均已装载）')

    const status = boot(root, ['status'])
    const loaded = status.loaded.find((item) => item.id === 'plugin-admin')
    assert.match(loaded.gen, /^[0-9a-f]{64}$/, 'plugin-admin 应有 active 代码世代')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    // 离线读投影：身份与 pins（host 保留字面量）
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const admin = projection.ids['plugin-admin']
    assert.ok(admin, '投影缺 plugin-admin')
    assert.equal(admin.pins.host, 'host', 'pins.host 应为保留字面量 host')
    assert.ok(admin.gens.length >= 1, 'plugin-admin 应有代码世代')
    assert.ok(projection.ids['toy-alpha'], '投影缺 toy-alpha')
    console.log('离线投影：pins.host=host、身份与世代正确')

    console.log(`E2E ok（root=${root}）`)
    console.log('注：运行时 port.call 往返未在此覆盖（宿主只在真实 call 期间路由），见文件头说明。')
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
