// `tool-fs` 宿主装配 E2E：
// pack sandbox + tool-fs → seed → start（宿主物化 + `cargo build --release` + 握手）→ 轮询 status 确认两身份 loaded
// → seed sandbox 档位映射数据世代 → 直连服务协议驱动工具（把 tool-fs 的 `port.call` 转发给真实 sandbox 服务）
// → stop → verify + replay → 离线读投影确认 sandbox body。
// 首跑 cargo 需下载 crates 与编译，`boot start` 的 10s 就绪等待可能先超时——宿主是 detached 进程，
// 仍在后台装配，故超时后转轮询（失败路径也 stop，释放单写者锁）。
// 用法：node plugins/tool-fs/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const SANDBOX_DIR = join(REPO_ROOT, 'plugins', 'sandbox')
const TOOLFS_DIR = join(REPO_ROOT, 'plugins', 'tool-fs')
const SANDBOX_SEED = join(SANDBOX_DIR, 'tools', 'seed-default-body.mjs')
const SANDBOX_BODY = join(SANDBOX_DIR, 'tools', 'default-body.json')
const EXE = process.platform === 'win32' ? '.exe' : ''
const BUILD_DEADLINE_MS = 20 * 60 * 1000

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
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

async function waitForLoaded(root, identities) {
  const deadline = Date.now() + BUILD_DEADLINE_MS
  let lastError = ''
  while (Date.now() < deadline) {
    const result = bootRaw(root, ['status'])
    if (result.status === 0 && result.parsed && Array.isArray(result.parsed.loaded)) {
      const loaded = result.parsed.loaded
      if (identities.every((id) => loaded.some((entry) => entry.id === id))) return result.parsed
    }
    lastError = result.stderr || result.stdout
    const log = lifecycleTail(root)
    if (/"event":"(start_failed|handshake\.failed|service\.exit)"/.test(log)) {
      throw new Error(`插件装配失败：\n${log}`)
    }
    await sleep(2000)
  }
  throw new Error(`身份未在期限内装载（${identities.join(', ')}；最后错误：${lastError}）\n${lifecycleTail(root)}`)
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** 极简协议客户端：按 4 字节大端长度前缀切帧。 */
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
      const timer = setTimeout(() => rejectFrame(new Error('等待协议帧超时')), 30000)
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
    }, 10000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

/** 直连 tool-fs 服务 stdio，把其 `port.call` 转发给真实 sandbox 服务（另起 stdio 子进程）。 */
async function directProtocolSmoke(toolfsBin, sandboxBin) {
  const stamp = `${process.pid}-${Date.now()}`
  const workspace = join(tmpdir(), 'kilo', `chrono-tool-fs-ws-${stamp}`)
  const outside = join(tmpdir(), 'kilo', `chrono-tool-fs-out-${stamp}`)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'alpha\nbeta\ngamma\n')
  writeFileSync(join(workspace, 'b.rs'), 'fn main() {}\n')
  writeFileSync(join(outside, 'secret.txt'), 'top secret\n')

  const toolfs = spawn(toolfsBin, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const sandbox = spawn(sandboxBin, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const tfNext = frameReader(toolfs)
  const sbNext = frameReader(sandbox)
  try {
    toolfs.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'tool-fs' }))
    const manifest = await tfNext()
    assert.equal(manifest.kind, 'manifest', 'tool-fs hello 应回 manifest')
    assert.equal(manifest.identity, 'tool-fs')
    assert.deepEqual(manifest.methods['tool-fs'], ['describe', 'invoke'])

    sandbox.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'sandbox' }))
    const sandboxManifest = await sbNext()
    assert.equal(sandboxManifest.kind, 'manifest', 'sandbox hello 应回 manifest')

    // 反向调用桥：tool-fs 发 port.call → 转发给 sandbox 的 call → 把应答回成 port.result / port.error。
    const callTool = async (id, method, args) => {
      toolfs.stdin.write(
        encodeFrame({
          v: '1',
          id,
          kind: 'call',
          port: 'tool-fs',
          method,
          args,
          env: { run: null, thread: null, now: 0 },
        }),
      )
      for (;;) {
        const message = await tfNext()
        if (message.kind === 'port.call') {
          sandbox.stdin.write(
            encodeFrame({
              v: '1',
              id: message.id,
              kind: 'call',
              port: message.port,
              method: message.method,
              args: message.args,
              env: { run: null, thread: null, now: 0 },
            }),
          )
          const response = await sbNext()
          if (response.kind === 'result') {
            toolfs.stdin.write(
              encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: response.value }),
            )
          } else {
            toolfs.stdin.write(
              encodeFrame({
                v: '1',
                id: message.id,
                kind: 'port.error',
                ok: false,
                error: response.code,
                message: response.message,
              }),
            )
          }
          continue
        }
        if ((message.kind === 'result' || message.kind === 'error') && message.id === id) return message
      }
    }

    const describe = await callTool('d1', 'describe', {})
    assert.equal(describe.kind, 'result', JSON.stringify(describe))
    assert.deepEqual(
      describe.value.tools.map((tool) => tool.name),
      ['read', 'edit', 'glob', 'grep'],
    )

    const base = {
      workspace_root: workspace,
      tier: 'severe',
      caps: { fs: { read: 'workspace', write: 'workspace' }, net: false },
    }

    const read = await callTool('r1', 'invoke', { tool: 'read', args: { path: 'a.txt' }, ...base })
    assert.equal(read.value.ok, true, JSON.stringify(read.value))
    assert.equal(read.value.result.text, 'alpha\nbeta\ngamma')
    assert.equal(read.value.result.total_lines, 3)

    const edit = await callTool('e1', 'invoke', {
      tool: 'edit',
      args: { path: 'a.txt', old: 'beta', new: 'BETA' },
      ...base,
    })
    assert.equal(edit.value.ok, true, JSON.stringify(edit.value))
    assert.equal(edit.value.result.replaced, 1)
    assert.ok(edit.value.result.patch.includes('+BETA'), '替换 patch 应含新增行')

    const create = await callTool('e2', 'invoke', {
      tool: 'edit',
      args: { path: 'new.txt', old: '', new: 'line1\nline2' },
      ...base,
    })
    assert.equal(create.value.ok, true, JSON.stringify(create.value))
    assert.equal(create.value.result.created, true)
    assert.equal(create.value.result.added, 2)
    assert.equal(readFileSync(join(workspace, 'new.txt'), 'utf8'), 'line1\nline2')

    const glob = await callTool('g1', 'invoke', {
      tool: 'glob',
      args: { pattern: '**/*.txt' },
      ...base,
    })
    assert.equal(glob.value.ok, true, JSON.stringify(glob.value))
    assert.ok(glob.value.result.paths.includes('a.txt'), JSON.stringify(glob.value.result.paths))

    const grep = await callTool('g2', 'invoke', { tool: 'grep', args: { pattern: 'BETA' }, ...base })
    assert.equal(grep.value.ok, true, JSON.stringify(grep.value))
    assert.equal(grep.value.result.matches[0].text, 'BETA')

    // 区外读：severe 档超出沙箱默认范围 → 真实 sandbox 拒，tool-fs 原样透传 fs_denied。
    const denied = await callTool('o1', 'invoke', {
      tool: 'read',
      args: { path: join(outside, 'secret.txt') },
      ...base,
    })
    assert.equal(denied.value.ok, false, JSON.stringify(denied.value))
    assert.equal(denied.value.error.code, 'fs_denied')

    console.log('直连协议：describe 四工具 + read/edit/new/glob/grep + 区外 severe fs_denied')
  } finally {
    toolfs.stdin.end()
    sandbox.stdin.end()
    await Promise.all([waitExit(toolfs), waitExit(sandbox)])
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-tool-fs-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packedSandbox = boot(root, ['pack', SANDBOX_DIR, '--identity', 'sandbox'])
    assert.equal(packedSandbox.ok, true, 'pack sandbox 报告 ok:false')
    const packedToolfs = boot(root, ['pack', TOOLFS_DIR, '--identity', 'tool-fs'])
    assert.equal(packedToolfs.ok, true, 'pack tool-fs 报告 ok:false')
    console.log(`pack：sandbox=${packedSandbox.status} tool-fs=${packedToolfs.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'sandbox', path: SANDBOX_DIR },
        { name: 'tool-fs', path: TOOLFS_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed：${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    try {
      boot(root, ['start'])
      console.log('start：宿主就绪')
    } catch (err) {
      if (!/start_timeout/.test(err.message)) throw err
      console.log('start：10s 就绪等待超时，宿主仍在后台物化 / 编译，转轮询 status')
    }
    started = true

    const status = await waitForLoaded(root, ['sandbox', 'tool-fs'])
    console.log(`status：loaded = ${status.loaded.map((entry) => entry.id).join(', ')}`)

    const sandboxBin = join(root, 'state', 'deps', 'cargo-target', 'release', `sandbox${EXE}`)
    const toolfsBin = join(root, 'state', 'deps', 'cargo-target', 'release', `tool-fs${EXE}`)
    assert.ok(existsSync(sandboxBin), `sandbox 缓存二进制缺失：${sandboxBin}`)
    assert.ok(existsSync(toolfsBin), `tool-fs 缓存二进制缺失：${toolfsBin}`)
    console.log(`物化：sandbox / tool-fs 二进制就位`)

    const seededBody = spawnSync(process.execPath, [SANDBOX_SEED, '--root', root], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    if (seededBody.status !== 0) {
      throw new Error(`seed 档位 body 失败：${seededBody.stderr || seededBody.stdout}`)
    }
    console.log('seed 档位映射 body：ok')

    await directProtocolSmoke(toolfsBin, sandboxBin)

    const afterSeed = boot(root, ['status'])
    assert.ok(
      afterSeed.loaded.some((entry) => entry.id === 'tool-fs'),
      `seed 后 tool-fs 未装载：${JSON.stringify(afterSeed.loaded)}`,
    )

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, afterSeed.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const expected = JSON.parse(readFileSync(SANDBOX_BODY, 'utf8'))
    assert.deepEqual(projection.ids.sandbox.body, expected)
    assert.ok(projection.ids['tool-fs'] !== undefined, '投影缺 tool-fs 身份')
    console.log('离线投影：ids.sandbox.body = 档位映射默认 body，tool-fs 身份在册')

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
