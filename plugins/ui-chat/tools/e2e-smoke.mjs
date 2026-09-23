// `ui-chat` 宿主装配 E2E（黑盒，经 boot CLI）：
// pack 冒烟 → 临时 root seed（ui-chat + input）→ start → 轮询 loaded →
// 命令面登记（ui-chat.client.read 只读命令可见）→ stop → verify + replay。
// 客户端半边改由插件自交付，HTTP / 端口 / SSE 面已作废，本脚本不再起任何监听。
// 失败路径同样 stop；用法：node plugins/ui-chat/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const CHAT_DIR = join(REPO_ROOT, 'plugins', 'ui-chat')
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

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-chat-e2e-${stamp}`)
  const packRoot = join(tmpdir(), 'kilo', `chrono-ui-chat-pack-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(packRoot, 'state'), { recursive: true })
  let started = false
  try {
    // 入世冒烟：单目录 pack
    const packed = boot(packRoot, ['pack', CHAT_DIR, '--identity', 'ui-chat'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    console.log(`pack: status=${packed.status} commit=${packed.commitHash}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'ui-chat', path: CHAT_DIR },
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
      return status.loaded.some((item) => item.id === 'ui-chat')
    }, 'ui-chat loaded', 180000)
    console.log('start + 握手：ok（ui-chat 已装载）')

    // 命令面：只读客户端半边交付命令已登记
    const commands = boot(root, ['commands'])
    const list = Array.isArray(commands) ? commands : (commands?.commands ?? [])
    const clientRead = list.find((item) => item.name === 'ui-chat.client.read')
    assert.ok(clientRead !== undefined, 'ui-chat.client.read 未登记')
    console.log('命令面：ok（ui-chat.client.read 只读命令已登记）')

    // 真实交付：经宿主命令面调用插件只读方法，读回产物字节
    const { connect } = await import(pathToFileURL(join(REPO_ROOT, 'packages', 'client', 'index.ts')).href)
    const client = await connect({ root })
    try {
      const result = await client.command('ui-chat.client.read', { path: 'dist/entry.js' })
      const evalObs = (result.observations ?? []).find((item) => item.kind === 'eval' && item.ok === true)
      const text = evalObs?.value?.text
      assert.equal(typeof text === 'string' && text.length > 0, true, `client.read 未返回产物字节：${JSON.stringify(result)}`)
      assert.match(text, /export/, 'client.read 返回值不是 ESM 产物')
      console.log(`client.read：ok（经宿主返回产物 ${text.length} 字节）`)
    } finally {
      client.close()
    }

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
