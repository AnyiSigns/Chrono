// `ui-threads` 宿主装配 E2E（黑盒，经 boot CLI）：
// pack 冒烟（并从入世源码树核验 `.worldignore`）→ 临时 root seed（ui-threads + session + todo + input）→
// start → 轮询 loaded → 命令面含 `ui-threads.client.read` → stop → verify + replay。
// 客户端半边改由插件自交付（只读命令 client.read），不再有子应用 HTTP 端口。
// 失败路径同样 stop；用法：node plugins/ui-threads/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const THREADS_DIR = join(REPO_ROOT, 'plugins', 'ui-threads')
const SESSION_DIR = join(REPO_ROOT, 'plugins', 'session')
const TODO_DIR = join(REPO_ROOT, 'plugins', 'todo')
const INPUT_DIR = join(REPO_ROOT, 'plugins', 'input')
const STORAGE_KV_DIR = join(REPO_ROOT, 'plugins', 'storage-kv')

function boot(root, args, env) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: env ?? process.env,
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

/** 从打包子操作里收集树内文件路径（目录 put 的 entries；文件条目 hash 是真实哈希）。 */
function collectPackedPaths(ops, rootIndex) {
  const paths = []
  const walk = (index, prefix) => {
    const body = ops[index]?.args?.body
    const entries = body?.entries
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const name = entry?.name
      if (typeof name !== 'string') continue
      const path = prefix.length === 0 ? name : `${prefix}/${name}`
      if (entry.mode === 'dir' && entry.hash !== null && typeof entry.hash === 'object' && Number.isInteger(entry.hash.$n)) {
        walk(entry.hash.$n, path)
      } else if (entry.mode === 'file') {
        paths.push(path)
      }
    }
  }
  walk(rootIndex, '')
  return paths
}

/** 离线核验 `.worldignore`：入世源码树不含 test/ / tools/ / dist，含 execute/ / terms/。 */
function packedPaths(dir) {
  const worldignore = readWorldignore(dir)
  assert.equal(worldignore.ok, true, '.worldignore 解析失败')
  const source = packSourceDir(dir, worldignore.patterns)
  return collectPackedPaths(source.ops, source.rootTreeIndex)
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-threads-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    // 入世冒烟：离线打包 + `.worldignore` 核验（无需起宿主，避免 needs 对提供方的入世门禁）。
    const paths = packedPaths(THREADS_DIR)
    assert.ok(!paths.some((entry) => entry.startsWith('test/')), `入世树含 test/：${paths.join(', ')}`)
    assert.ok(!paths.some((entry) => entry.startsWith('tools/')), `入世树含 tools/：${paths.join(', ')}`)
    assert.ok(paths.some((entry) => entry.startsWith('execute/')), '入世树缺 execute/')
    assert.ok(paths.some((entry) => entry.startsWith('terms/')), '入世树缺 terms/')
    console.log(`pack：.worldignore 生效（${paths.length} 项，无 test/ 与 tools/）`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'input', path: INPUT_DIR },
        { name: 'session', path: SESSION_DIR },
        { name: 'storage-kv', path: STORAGE_KV_DIR },
        { name: 'todo', path: TODO_DIR },
        { name: 'ui-threads', path: THREADS_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'])
      const loaded = status.loaded.map((item) => item.id)
      return ['ui-threads', 'session', 'todo', 'input'].every((id) => loaded.includes(id))
    }, 'ui-threads + session + todo + input loaded', 180000)
    console.log('start + 握手：ok（ui-threads / session / todo / input 已装载）')

    // 命令面：客户端半边自交付的只读命令已声明（产物构建成功才会装载成功）
    const commands = boot(root, ['commands'])
    assert.ok(
      JSON.stringify(commands).includes('ui-threads.client.read'),
      `命令面应含 ui-threads.client.read：${JSON.stringify(commands)}`,
    )
    console.log('commands：ok（ui-threads.client.read 已声明）')

    const status = boot(root, ['status'])
    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'])
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
