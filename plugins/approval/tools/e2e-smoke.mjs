// `approval` 宿主装配 E2E（黑盒，经 boot CLI + 直连服务协议）：
// pack approval → seed → 离线读投影确认身份在册、schema periodic 可解析、
// 代码树按 .worldignore 排除 test/ 与 tools/ → start → 握手 → stop → verify + replay
// → 直连 approval 服务，覆盖 enqueue / list / decide / sweep 与写计划形状。
// 用法：node plugins/approval/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'
import { readPeriodicEntries } from '../../../packages/host/periodic.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const APPROVAL_DIR = join(REPO_ROOT, 'plugins', 'approval')
const FIXED_NOW = 1_700_000_000_000
const AT = new Date(FIXED_NOW).toISOString()

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

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

function frameReader(child) {
  let buffer = Buffer.alloc(0)
  const queued = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const body = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      const message = JSON.parse(body.toString('utf8'))
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(message)
      else queued.push(message)
    }
  })
  return () =>
    new Promise((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => rejectFrame(new Error('等待协议帧超时')), 15000)
      const done = (message) => {
        clearTimeout(timer)
        resolveFrame(message)
      }
      if (queued.length > 0) done(queued.shift())
      else waiters.push(done)
    })
}

function waitExit(child) {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill()
      resolveExit()
    }, 8000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  return extern?.payload ?? null
}

/** 世界不新增世代的机械证据：返回值里不得出现任何 write / add_gen。 */
function assertNoWorldWrite(value) {
  for (const directive of directivesOf(value)) {
    assert.notEqual(directive.kind, 'write', `不应产世界写：${JSON.stringify(directive)}`)
    assert.equal(JSON.stringify(directive).includes('add_gen'), false, '不应出现 add_gen')
  }
}

/** 从代码树收集全部文件路径（tree def = {entries:[{name,mode,hash}]}）。 */
function collectPaths(world, treeHash, prefix = '') {
  const body = world.defs[treeHash]?.body
  const entries = Array.isArray(body?.entries) ? body.entries : []
  const paths = []
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.mode === 'dir') paths.push(...collectPaths(world, entry.hash, path))
    else paths.push(path)
  }
  return paths
}

async function directProtocolSmoke(entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(dirname(entry)),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const next = frameReader(child)
  const events = []
  const env = { run: 'e2e-run', thread: 't1', now: FIXED_NOW }

  async function call(id, method, args, callEnv = env) {
    child.stdin.write(encodeFrame({ v: '1', id, kind: 'call', port: 'approval', method, args, env: callEnv }))
    for (;;) {
      const message = await next()
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if ((message.kind === 'result' || message.kind === 'error') && message.id === id) return message
    }
  }

  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'approval' }))
    const manifest = await next()
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.identity, 'approval')
    assert.deepEqual(manifest.methods.approval, ['enqueue', 'list', 'decide', 'decide_all', 'sweep'])

    const enqueued = await call('e1', 'enqueue', {
      kind: 'tool_call',
      port: 'tool-shell',
      args_ref: { summary: 'rm -rf build' },
      tier: 'severe',
      run: 'e2e-run',
      thread: 't1',
      cursor: { node_index: 3 },
      at: AT,
    })
    assert.equal(enqueued.kind, 'result', JSON.stringify(enqueued))
    assertNoWorldWrite(enqueued.value)
    const enqueuePayload = externOf(enqueued.value)
    assert.equal(enqueuePayload.ok, true)
    assert.equal(enqueuePayload.id, 'ap-e2e-run-0')
    assert.equal(enqueuePayload.count, 1)
    const pending = events.find((event) => event.topic === 'approval.pending')
    assert.ok(pending, 'enqueue 应即发 approval.pending')
    assert.equal(pending.payload.kind, 'tool_call')

    const listed = await call('e2', 'list', {})
    const item = externOf(listed.value).items[0]
    assert.equal(item.id, 'ap-e2e-run-0')
    assert.equal(item.thread, 't1')
    assert.deepEqual(item.resume, { command: 'chat.resume', args: { cursor: { node_index: 3 }, thread: 't1' } })
    assert.equal(externOf(listed.value).pending, 1)

    const decided = await call('e3', 'decide', { id: 'ap-e2e-run-0', verdict: 'accept', thread_id: 't1', at: AT })
    assertNoWorldWrite(decided.value)
    assert.equal(externOf(decided.value).status, 'approved')
    assert.deepEqual(externOf(decided.value).resume, { command: 'chat.resume', args: { cursor: { node_index: 3 }, thread: 't1' } })
    assert.equal(directivesOf(decided.value).some((item) => item.kind === 'eval'), false)
    assert.ok(events.some((event) => event.topic === 'approval.decided'))

    // 再入队一条 pending，供超时 sweep（已裁决项不因超时改变）。
    await call('e4', 'enqueue', { kind: 'tool_call', run: 'e2e-run', thread: 't1', cursor: { node_index: 9 }, at: AT })
    const swept = await call('e5', 'sweep', {}, { run: null, thread: null, now: FIXED_NOW + 11 * 60 * 1000 })
    assert.equal(externOf(swept.value).expired, 1)
    assert.equal(externOf((await call('e6', 'list', {})).value).items[1].status, 'expired')

    console.log('直连协议：enqueue / list / decide / sweep + 自有存储 + 事件时机')
  } finally {
    child.stdin.end()
    await waitExit(child)
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-approval-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packed = boot(root, ['pack', APPROVAL_DIR, '--identity', 'approval'])
    assert.equal(packed.ok, true, `pack approval 报告 ok:false：${JSON.stringify(packed)}`)
    console.log(`pack approval: ${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'approval', path: APPROVAL_DIR }]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head, { blobsDir: paths.blobsDir })
    const identity = projection.ids.approval
    assert.ok(identity, '投影缺 approval 身份')
    assert.equal(identity.pins && Object.keys(identity.pins).length, 0, 'approval 应无 pins')

    // schema periodic：宿主按裸方法名 sweep 解析
    const periodic = readPeriodicEntries(anchor.world)
    assert.deepEqual(periodic.invalid, [])
    assert.equal(periodic.entries.length, 1)
    assert.equal(periodic.entries[0].identity, 'approval')
    assert.equal(periodic.entries[0].method, 'sweep')
    console.log('schema periodic：sweep 已登记（裸方法名）')

    // .worldignore：test/ 与 tools/ 不入代码树
    const commitHash = identity.gens[identity.gens.length - 1].payload
    const treeHash = anchor.world.defs[commitHash].body.tree
    const files = collectPaths(anchor.world, treeHash)
    for (const required of ['plugin.json', 'package.json', 'README.md', 'schema/approval.json', 'execute/main.ts']) {
      assert.ok(files.includes(required), `代码树缺 ${required}`)
    }
    assert.equal(files.some((path) => path.startsWith('test/')), false, 'test/ 不应入世')
    assert.equal(files.some((path) => path.startsWith('tools/')), false, 'tools/ 不应入世')
    assert.equal(files.includes('.worldignore'), false, '.worldignore 自身不应入世')
    console.log(`.worldignore：代码树 ${files.length} 个文件，test/ 与 tools/ 已排除`)

    boot(root, ['start'])
    started = true
    // 服务握手是异步的：轮询 status 直到 approval 装载（或超时）。
    let status = boot(root, ['status'])
    const deadline = Date.now() + 30000
    while (!status.loaded.some((item) => item.id === 'approval') && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
      status = boot(root, ['status'])
    }
    assert.ok(
      status.loaded.some((item) => item.id === 'approval'),
      'approval 服务应完成握手装载',
    )
    console.log('start + 握手：ok')

    boot(root, ['stop'])
    started = false
    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    await directProtocolSmoke(join(APPROVAL_DIR, 'execute', 'main.ts'))

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
