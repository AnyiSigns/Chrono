// storage-kv 端到端冒烟（黑盒，经 boot CLI）：pack → seed → start → 核对声明 / 命令 / .worldignore
// → 核对宿主为 durable 身份建了 ④ 目录 → stop。任何失败路径都会尝试 stop 释放锁。
// 用法：node plugins/storage-kv/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const PKG_DIR = join(REPO_ROOT, 'plugins', 'storage-kv')
const IDENTITY = 'storage-kv'

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
  const root = join(tmpdir(), 'kilo', `chrono-storage-kv-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packed = boot(root, ['pack', PKG_DIR, '--identity', IDENTITY])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    assert.equal(packed.identity, IDENTITY)
    console.log(`pack ${IDENTITY}: ${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: IDENTITY, path: PKG_DIR }], null, 2),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    const status = boot(root, ['status'])
    const loaded = status.loaded.map((entry) => entry.id)
    assert.ok(loaded.includes(IDENTITY), `loaded 缺 ${IDENTITY}：${loaded.join(',')}`)
    console.log(`status.loaded: ${loaded.join(' ')}`)

    const dataDir = join(root, 'state', 'data', IDENTITY)
    assert.ok(existsSync(dataDir), `未建 ④ 目录 ${dataDir}`)
    console.log(`durable dir: ${dataDir}`)

    const commands = boot(root, ['commands'])
    assert.equal(
      commands.some((command) => command.identity === IDENTITY),
      false,
      'storage-kv 不应声明命令',
    )
    console.log('commands: storage-kv 无命令（符合声明）')

    const worldignore = readFileSync(join(PKG_DIR, '.worldignore'), 'utf8')
    assert.match(worldignore, /^test\/$/m)
    assert.match(worldignore, /^tools\/$/m)
    console.log('.worldignore: test/ tools/ 已排除')

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
