// 数据身份 E2E 冒烟（黑盒，经 boot CLI）：pack → seed → start → 写 config 世界基线（定义缺省）
// → config.read（owner 合并世界基线 + 自有存储）/ input.read（服务自有存储）读回 → stop。
// 运行记录已出世界：input / short-memory 的世界缺省写入不再被读；只 config 的判定阈值基线仍进世界。
// 宿主是单写者，任何失败路径都会尝试 stop 释放锁。
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
const CONFIG_DIR = join(REPO_ROOT, 'plugins', 'config')

const PACKAGES = [
  { id: 'input', dir: join(REPO_ROOT, 'plugins', 'input') },
  { id: 'config', dir: CONFIG_DIR },
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

    // 只把 config 的缺省 body 写进世界：它承载判定阈值基线（permission / params / version）。
    // input / short-memory 的运行记录已出世界，不再写世界缺省。
    const configBody = JSON.parse(readFileSync(join(CONFIG_DIR, 'tools', 'default-body.json'), 'utf8'))
    const directive = [
      {
        kind: 'write',
        request: {
          id: 'e2e-config-baseline',
          op: 'batch',
          target: { expect_pos: expectPos },
          args: {
            ops: [
              { op: 'put', args: { body: configBody } },
              { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
          by: 'e2e',
        },
      },
    ]
    const written = boot(root, ['run', JSON.stringify(directive)])
    assert.equal(written.status, 'done', `写入未完成：${JSON.stringify(written)}`)
    console.log('write config baseline: done')

    // config.read 经 owner 服务合并世界基线 + 自有存储（空）→ 默认配置。
    const configRead = boot(root, ['config.read'])
    const readBody = configRead.observations[0].value.body
    assert.equal(readBody.version, 1)
    assert.equal(readBody.permission, 'review')
    assert.equal(readBody.ui.theme, 'system')
    assert.deepEqual(readBody.providers, {})
    console.log('config.read: ok（owner 合并世界基线）')

    // input.read 走服务自有存储（世界缺省不再被读）；空存储 → 空槽表。
    const inputRead = boot(root, ['input.read'])
    const inputBody = inputRead.observations[0].value
    assert.ok(inputBody !== null && typeof inputBody === 'object', 'input.read 应回对象')
    assert.equal(Object.keys(inputBody.slots ?? {}).length, 0, '空存储无槽')
    console.log('input.read: ok（服务自有存储）')

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
