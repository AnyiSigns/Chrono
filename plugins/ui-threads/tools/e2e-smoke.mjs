// `ui-threads` 宿主装配 E2E（黑盒，经 boot CLI）：
// pack 冒烟（并从入世源码树核验 `.worldignore`）→ 临时 root seed（ui-threads + session + todo + input）→
// start → 轮询 loaded → 命令面含 `ui-threads.client.read` → stop → verify + replay。
// 客户端半边改由插件自交付（只读命令 client.read），不再有子应用 HTTP 端口。
// 失败路径同样 stop；用法：node plugins/ui-threads/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const THREADS_DIR = join(REPO_ROOT, 'plugins', 'ui-threads')
const SESSION_DIR = join(REPO_ROOT, 'plugins', 'session')
const TODO_DIR = join(REPO_ROOT, 'plugins', 'todo')
const INPUT_DIR = join(REPO_ROOT, 'plugins', 'input')

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

/** 从 journal 收集所有 def body（顶层 put 与 batch 子操作的 put）。 */
function journalBodies(journalPath) {
  let text = ''
  try {
    text = readFileSync(journalPath, 'utf8')
  } catch {
    return []
  }
  const bodies = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.op === 'put' && entry.args !== null && typeof entry.args === 'object') {
      bodies.push(entry.args.body)
    }
    if (entry.op === 'batch' && entry.args !== null && typeof entry.args === 'object' && Array.isArray(entry.args.ops)) {
      for (const op of entry.args.ops) {
        if (op.op === 'put' && op.args !== null && typeof op.args === 'object') bodies.push(op.args.body)
      }
    }
  }
  return bodies
}

/** 核验 `.worldignore`：入世源码树的根 tree 不含 `test/` / `tools/` / `dist`，含 `execute/` / `terms/`。 */
function assertWorldignoreExcludes(journalPath) {
  const rootTrees = journalBodies(journalPath).filter(
    (body) =>
      body !== null &&
      typeof body === 'object' &&
      Array.isArray(body.entries) &&
      body.entries.some((entry) => entry.name === 'plugin.json'),
  )
  assert.ok(rootTrees.length > 0, '入世源码树里找不到根 tree（plugin.json）')
  for (const tree of rootTrees) {
    const names = tree.entries.map((entry) => entry.name)
    assert.equal(names.includes('test'), false, `根 tree 不应含 test/：${names.join(',')}`)
    assert.equal(names.includes('tools'), false, `根 tree 不应含 tools/：${names.join(',')}`)
    assert.ok(names.includes('execute'), '根 tree 应含 execute/')
    assert.ok(names.includes('terms'), '根 tree 应含 terms/')
  }
  return rootTrees[0].entries.length
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-threads-e2e-${stamp}`)
  const packRoot = join(tmpdir(), 'kilo', `chrono-ui-threads-pack-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(packRoot, 'state'), { recursive: true })
  let started = false
  try {
    // 入世冒烟：单目录 pack + `.worldignore` 核验
    const packed = boot(packRoot, ['pack', THREADS_DIR, '--identity', 'ui-threads'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    const entries = assertWorldignoreExcludes(join(packRoot, 'state', 'world', 'journal.jsonl'))
    console.log(`pack: status=${packed.status} commit=${packed.commitHash}；.worldignore 生效（根 tree ${entries} 项，无 test/ 与 tools/）`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'ui-threads', path: THREADS_DIR },
        { name: 'session', path: SESSION_DIR },
        { name: 'todo', path: TODO_DIR },
        { name: 'input', path: INPUT_DIR },
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
    rmSync(packRoot, { recursive: true, force: true })
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (err) {
      console.error(`清理临时 root 失败（不影响结果）：${err.message}`)
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
