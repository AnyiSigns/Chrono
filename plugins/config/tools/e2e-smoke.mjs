// 三包合并 E2E 冒烟（黑盒，经 boot CLI）：pack → seed → start → 写默认 body（数据世代）
// → input.read / config.read 读回 → stop。宿主是单写者，任何失败路径都会尝试 stop 释放锁。
// 用法：node plugins/config/tools/e2e-smoke.mjs
// 临时根目录建在系统临时目录的 kilo/ 下，执行后可留作排查。
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')

const PACKAGES = [
  { id: 'input', dir: join(REPO_ROOT, 'plugins', 'input') },
  { id: 'config', dir: join(REPO_ROOT, 'plugins', 'config') },
  { id: 'short-memory', dir: join(REPO_ROOT, 'plugins', 'short-memory') },
]

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

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-data-identities-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    for (const pkg of PACKAGES) {
      const packed = boot(root, ['pack', pkg.dir, '--identity', pkg.id])
      assert.equal(packed.ok, true, `pack ${pkg.id} 报告 ok:false`)
      console.log(`pack ${pkg.id}: ${packed.status}`)
    }

    const manifest = PACKAGES.map((pkg) => ({ name: pkg.id, path: pkg.dir }))
    writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify(manifest, null, 2))
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true
    const status = boot(root, ['status'])
    const expectPos = status.world_head.hash

    const ops = []
    for (const pkg of PACKAGES) {
      const body = JSON.parse(readFileSync(join(pkg.dir, 'tools', 'default-body.json'), 'utf8'))
      const index = ops.length
      ops.push({ op: 'put', args: { body } })
      ops.push({
        op: 'add_gen',
        args: { id: pkg.id, payload: { $n: index }, sig: { $n: index }, pins: {} },
      })
    }
    const directive = [
      {
        kind: 'write',
        request: {
          id: 'e2e-default-bodies',
          op: 'batch',
          target: { expect_pos: expectPos },
          args: { ops },
          by: 'e2e',
        },
      },
    ]
    const written = boot(root, ['run', JSON.stringify(directive)])
    assert.equal(written.status, 'done', `写入未完成：${JSON.stringify(written)}`)
    console.log('write defaults: done')

    const inputRead = boot(root, ['input.read'])
    const inputBody = inputRead.observations[0].value
    assert.deepEqual(inputBody, { slots: {} })
    console.log('input.read: ok')

    const configRead = boot(root, ['config.read'])
    const configBody = configRead.observations[0].value
    assert.equal(configBody.version, 1)
    assert.equal(configBody.permission, 'review')
    assert.equal(configBody.ui.theme, 'system')
    assert.deepEqual(configBody.providers, {})
    console.log('config.read: ok')

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
