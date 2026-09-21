// `workspace` 宿主装配 E2E（重点验证 H15 Rust 物化链路 + 写计划方言）：
// 临时 root → pack workspace + input → seed（入世）→ start（物化 + cargo build + launch.mjs 拉起 + 握手）
// → 轮询 status 确认 loaded → seed 默认 body → 协议直连驱动 list / add（args 带槽体、输入 body 与 workspaces body）
// → 把服务返回的计划经 boot run 落账 → stop → verify + replay → 离线读投影断言 body 与 per-thread 清槽。
// 首跑 cargo 需编译（crates 已缓存），`boot start` 的 10s 就绪等待可能先超时——宿主是 detached 进程，
// 仍在后台装配，故超时后转轮询（失败路径也 stop，释放单写者锁）。
// 用法：node plugins/workspace/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
const WORKSPACE_DIR = join(REPO_ROOT, 'plugins', 'workspace')
const INPUT_DIR = join(REPO_ROOT, 'plugins', 'input')
const SEED_SCRIPT = join(WORKSPACE_DIR, 'tools', 'seed-default-body.mjs')
const BIN_NAME = process.platform === 'win32' ? 'workspace.exe' : 'workspace'
const BUILD_DEADLINE_MS = 20 * 60 * 1000

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

/** 归一 `\\?\` / `\\?\UNC\` verbatim 前缀（与 Rust / seed 脚本同口径）。 */
function stripVerbatim(text) {
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice(8)}`
  if (text.startsWith('\\\\?\\')) return text.slice(4)
  return text
}

function bootRaw(root, args) {
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
  return { status: result.status, stdout, stderr: result.stderr, parsed }
}

function boot(root, args) {
  const result = bootRaw(root, args)
  if (result.status !== 0) {
    throw new Error(`boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  return result.parsed
}

function lifecycleTail(root) {
  const file = join(root, 'state', 'lifecycle.log')
  if (!existsSync(file)) return ''
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  return lines.slice(-20).join('\n')
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** 协议直连的临时客户端：独立 spawn 一份服务实例，只为取方法返回值 / 计划。 */
function startService(exe, stateDir) {
  const child = spawn(exe, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CHRONO_PLUGIN_STATE: stateDir },
    windowsHide: true,
  })
  let buffer = Buffer.alloc(0)
  let nextId = 1
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
      buffer = buffer.subarray(4 + length)
      const resolvePending = pending.get(message.id)
      if (resolvePending !== undefined) {
        pending.delete(message.id)
        resolvePending(message)
      }
    }
  })
  const request = (message) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = `e2e-${nextId++}`
      const timer = setTimeout(() => rejectRequest(new Error(`服务无响应：${JSON.stringify(message)}`)), 15000)
      pending.set(id, (reply) => {
        clearTimeout(timer)
        resolveRequest(reply)
      })
      child.stdin.write(frame({ v: '1', ...message, id }))
    })
  return { request, stop: () => child.kill() }
}

async function waitForLoaded(root) {
  const deadline = Date.now() + BUILD_DEADLINE_MS
  let lastError = ''
  while (Date.now() < deadline) {
    const result = bootRaw(root, ['status'])
    if (result.status === 0 && result.parsed && Array.isArray(result.parsed.loaded)) {
      if (result.parsed.loaded.some((entry) => entry.id === 'workspace')) return result.parsed
    }
    lastError = result.stderr || result.stdout
    const log = lifecycleTail(root)
    if (/"impl":"workspace"/.test(log) && /"event":"(start_failed|handshake.failed)"/.test(log)) {
      throw new Error(`workspace 装配失败：\n${log}`)
    }
    await sleep(2000)
  }
  throw new Error(`workspace 未在期限内装载（最后错误：${lastError}）\n${lifecycleTail(root)}`)
}

function readProjection(root) {
  const paths = hostPaths(root)
  const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
  return projectBaseOnly(anchor.world, anchor.head)
}

/** 计划条目 → 可直接提交的 directives：write 机械填 id / by / expect_pos，extern 原样。 */
function planToDirectives(plan, head) {
  const items = plan.$directives
  assert.ok(Array.isArray(items), '计划缺少 $directives 数组')
  return items.map((item, index) => {
    if (item.kind === 'write') {
      return {
        kind: 'write',
        request: {
          ...item.request,
          id: `e2e-plan-${index}`,
          target: { expect_pos: head },
          by: 'e2e-smoke',
        },
      }
    }
    return item
  })
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-workspace-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  const addedDir = join(root, 'added-ws')
  mkdirSync(addedDir, { recursive: true })
  let started = false
  let service = null
  try {
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'workspace', path: WORKSPACE_DIR },
        { name: 'input', path: INPUT_DIR },
      ]),
    )
    const seededWorld = boot(root, ['seed'])
    assert.equal(seededWorld.ok, true, 'seed 报告 ok:false')
    console.log(`seed：${seededWorld.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    try {
      boot(root, ['start'])
      console.log('start：宿主就绪')
    } catch (err) {
      if (!/start_timeout/.test(err.message)) throw err
      console.log('start：10s 就绪等待超时，宿主仍在后台物化 / 编译，转轮询 status')
    }
    started = true

    const status = await waitForLoaded(root)
    console.log(`status：loaded = ${status.loaded.map((entry) => entry.id).join(', ')}`)

    const binPath = join(root, 'state', 'deps', 'cargo-target', 'release', BIN_NAME)
    assert.ok(existsSync(binPath), `缓存二进制缺失：${binPath}`)
    console.log(`H15：二进制就位（${binPath}）`)

    const seededBody = spawnSync(process.execPath, [SEED_SCRIPT, '--root', root], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    if (seededBody.status !== 0) {
      throw new Error(`seed 脚本失败（exit ${seededBody.status}）：${seededBody.stderr || seededBody.stdout}`)
    }
    const seeded = JSON.parse(seededBody.stdout.trim())
    assert.equal(seeded.ok, true, 'seed 脚本报告 ok:false')
    console.log(`seed 默认 body：workspace_id=${seeded.workspace_id} path=${seeded.path}`)

    const before = readProjection(root)
    const workspacesBody = before.ids.workspace.body
    assert.equal(workspacesBody.workspaces.length, 1)
    assert.equal(workspacesBody.workspaces[0].id, seeded.workspace_id)

    service = startService(binPath, join(root, 'state', 'plugins', 'workspace'))
    const hello = await service.request({ kind: 'hello', impl: 'workspace' })
    assert.equal(hello.kind, 'manifest')
    assert.equal(hello.identity, 'workspace')
    assert.deepEqual(hello.methods.workspace, ['list', 'pick', 'add', 'remove', 'reveal'])

    const listReply = await service.request({
      kind: 'call',
      port: 'workspace',
      method: 'list',
      args: workspacesBody,
      env: { run: 'e2e', thread: '_main', now: 0 },
    })
    assert.equal(listReply.ok, true)
    assert.equal(listReply.value.length, 1)
    assert.equal(listReply.value[0].id, seeded.workspace_id)
    assert.equal(listReply.value[0].missing, false)
    console.log('协议直连 list：ok（missing=false）')

    const addReply = await service.request({
      kind: 'call',
      port: 'workspace',
      method: 'add',
      args: {
        slot: { kind: 'workspace.add', workspace: 'ws-added', path: addedDir },
        slots: { slots: { _main: { kind: 'workspace.add' }, other: { kind: 'chat.message' } } },
        body: workspacesBody,
        thread_id: '_main',
      },
      env: { run: 'e2e', thread: '_main', now: 0 },
    })
    assert.equal(addReply.ok, true, `add 返回 error：${JSON.stringify(addReply)}`)
    const plan = addReply.value
    const ops = plan.$directives[0].request.args.ops
    assert.equal(plan.$directives.length, 2)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen', 'put', 'add_gen'])
    assert.equal(ops[1].args.id, 'workspace')
    assert.deepEqual(ops[1].args.payload, { $n: 0 })
    assert.equal(ops[3].args.id, 'input')
    assert.deepEqual(ops[3].args.payload, { $n: 2 })
    assert.deepEqual(plan.$directives[1].payload, { ok: true, workspace: 'ws-added' })
    console.log('协议直连 add：计划 ops 序与占位符 ok')

    const head = boot(root, ['status']).world_head.hash
    const runResult = boot(root, ['run', JSON.stringify(planToDirectives(plan, head))])
    assert.equal(runResult.status, 'done', `落账未完成：${JSON.stringify(runResult)}`)
    console.log('boot run：计划落账 ok')

    const after = readProjection(root)
    const list = after.ids.workspace.body.workspaces
    assert.equal(list.length, 2, '工作区列表未追加')
    const added = list.find((item) => item.id === 'ws-added')
    assert.ok(added !== undefined, '未找到新增工作区')
    const expectedPath = stripVerbatim(realpathSync.native(addedDir))
    assert.equal(added.path.toLowerCase(), expectedPath.toLowerCase())
    assert.equal(added.name, 'added-ws')
    assert.equal(list[0].id, seeded.workspace_id, '既有条目应保留且顺序在前')
    assert.deepEqual(after.ids.input.body.slots._main, { kind: 'idle' })
    assert.deepEqual(after.ids.input.body.slots.other, { kind: 'chat.message' })
    console.log('离线投影：workspaces body 已追加、per-thread 清槽正确')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, after.head, 'replay 链头与落账后投影不一致')
    console.log('verify + replay：ok')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    if (service !== null) service.stop()
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
