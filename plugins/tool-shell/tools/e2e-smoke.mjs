// `tool-shell` 宿主装配 E2E：
// pack secrets + sandbox + tool-shell → seed → start（宿主物化 + `cargo build --release` + 握手）
// → 轮询 status 确认三身份 loaded → seed sandbox 档位映射数据世代 → 写本地密钥文件
// → 直连 tool-shell 服务协议，把它的 `port.call` 分别桥接到真实 sandbox 二进制与真实 secrets 服务
// → stop → verify + replay → 离线读投影确认 sandbox body 与 tool-shell 身份在册。
// 首跑 cargo 需下载 crates 与编译，`boot start` 的 10s 就绪等待可能先超时——宿主是 detached 进程，
// 仍在后台装配，故超时后转轮询（失败路径也 stop，释放单写者锁）。
// 用法：node plugins/tool-shell/tools/e2e-smoke.mjs
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
const SECRETS_DIR = join(REPO_ROOT, 'plugins', 'secrets')
const SANDBOX_DIR = join(REPO_ROOT, 'plugins', 'sandbox')
const TOOL_SHELL_DIR = join(REPO_ROOT, 'plugins', 'tool-shell')
const SANDBOX_SEED = join(SANDBOX_DIR, 'tools', 'seed-default-body.mjs')
const SANDBOX_BODY = join(SANDBOX_DIR, 'tools', 'default-body.json')
const EXE = process.platform === 'win32' ? '.exe' : ''
const BUILD_DEADLINE_MS = 20 * 60 * 1000
const E2E_SECRET = 'chrono-e2e-secret-value'

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
  return readFileSync(file, 'utf8').trim().split('\n').slice(-20).join('\n')
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
      const timer = setTimeout(() => rejectFrame(new Error('等待协议帧超时')), 60000)
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

/**
 * 直连 tool-shell 服务 stdio，把它的 `port.call` 桥接到真实 sandbox 二进制与真实 secrets 服务：
 * `sandbox.exec` → sandbox 的 call 帧；`secrets.resolve` → secrets 的 call 帧；应答回 port.result / port.error。
 */
async function directProtocolSmoke(toolShellEntry, sandboxBin, secretsStateDir) {
  const workspace = join(tmpdir(), 'kilo', `chrono-tool-shell-ws-${process.pid}-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'alpha\n')

  const toolShell = spawn(process.execPath, [toolShellEntry], {
    cwd: TOOL_SHELL_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const sandbox = spawn(sandboxBin, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const secrets = spawn(process.execPath, ['execute/main.ts'], {
    cwd: SECRETS_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CHRONO_PLUGIN_STATE: secretsStateDir },
  })
  const tsNext = frameReader(toolShell)
  const sbNext = frameReader(sandbox)
  const secNext = frameReader(secrets)
  const portCalls = []

  const backendOf = (port) => (port === 'sandbox' ? { child: sandbox, next: sbNext } : { child: secrets, next: secNext })

  async function bridge(message) {
    portCalls.push(message)
    const backend = backendOf(message.port)
    backend.child.stdin.write(
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
    const response = await backend.next()
    if (response.kind === 'result') {
      toolShell.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: response.value }))
    } else {
      toolShell.stdin.write(
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
  }

  async function callTool(id, method, args) {
    toolShell.stdin.write(
      encodeFrame({ v: '1', id, kind: 'call', port: 'tool-shell', method, args, env: { run: null, thread: null, now: 0 } }),
    )
    for (;;) {
      const message = await tsNext()
      if (message.kind === 'port.call') {
        await bridge(message)
        continue
      }
      if ((message.kind === 'result' || message.kind === 'error') && message.id === id) return message
    }
  }

  try {
    toolShell.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'tool-shell' }))
    const manifest = await tsNext()
    assert.equal(manifest.kind, 'manifest', 'tool-shell hello 应回 manifest')
    assert.equal(manifest.identity, 'tool-shell')
    assert.deepEqual(manifest.methods['tool-shell'], ['describe', 'invoke'])

    sandbox.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'sandbox' }))
    assert.equal((await sbNext()).kind, 'manifest', 'sandbox hello 应回 manifest')
    secrets.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'secrets' }))
    assert.equal((await secNext()).kind, 'manifest', 'secrets hello 应回 manifest')

    const describe = await callTool('d1', 'describe', {})
    assert.equal(describe.kind, 'result', JSON.stringify(describe))
    assert.deepEqual(describe.value.tools.map((tool) => tool.name), ['shell'])

    const base = {
      tier: 'severe',
      workspace_root: workspace,
      caps: { fs: { read: 'workspace', write: 'workspace' }, net: 'none' },
    }

    const echo = await callTool('c1', 'invoke', { tool: 'shell', args: { input: 'echo chrono' }, ...base })
    assert.equal(echo.value.ok, true, JSON.stringify(echo.value))
    assert.equal(echo.value.result.kind, 'terminal')
    assert.equal(echo.value.result.exit_code, 0)
    assert.ok(echo.value.result.stdout.includes('chrono'), echo.value.result.stdout)

    const code = await callTool('c2', 'invoke', {
      tool: 'shell',
      args: { mode: 'code', language: 'javascript', input: 'console.log(JSON.stringify({ok:true}))' },
      ...base,
    })
    assert.equal(code.value.ok, true, JSON.stringify(code.value))
    assert.equal(code.value.result.kind, 'json')
    assert.deepEqual(code.value.result.value, { ok: true })

    // 密钥注入：真 secrets 服务解析本地文件，明文只经 exec env 下传；命令只回 presence，不回值。
    const secret = await callTool('s1', 'invoke', {
      tool: 'shell',
      args: {
        mode: 'code',
        language: 'javascript',
        input: "console.log(process.env.E2E_TOKEN ? 'present' : 'absent')",
      },
      auth_ref: { kind: 'local', name: 'E2E_TOKEN' },
      ...base,
    })
    assert.equal(secret.value.ok, true, JSON.stringify(secret.value))
    assert.ok(secret.value.result.stdout.includes('present'), secret.value.result.stdout)
    assert.equal(JSON.stringify(secret.value).includes(E2E_SECRET), false, '明文不得进结果')
    assert.ok(
      portCalls.some((call) => call.port === 'secrets' && call.method === 'resolve'),
      '应经反向 port.call 调 secrets.resolve',
    )
    const execCall = portCalls.find((call) => call.port === 'sandbox' && call.method === 'exec' && call.args.env)
    assert.equal(execCall.args.env.E2E_TOKEN, E2E_SECRET, '明文应只经 exec env 下传')

    // 非零退出：结果仍回带 exit_code。
    const failInput = process.platform === 'win32' ? 'exit /b 3' : 'exit 3'
    const nonzero = await callTool('c3', 'invoke', { tool: 'shell', args: { input: failInput }, ...base })
    assert.equal(nonzero.value.ok, false, JSON.stringify(nonzero.value))
    assert.equal(nonzero.value.error.code, 'nonzero_exit')
    assert.equal(nonzero.value.result.exit_code, 3)

    // sandbox 档位拒绝原样透传：deny 档直接拒 exec。
    const denied = await callTool('c4', 'invoke', {
      tool: 'shell',
      args: { input: 'echo nope' },
      tier: 'deny',
      workspace_root: workspace,
      caps: base.caps,
    })
    assert.equal(denied.value.ok, false, JSON.stringify(denied.value))
    assert.equal(denied.value.error.code, 'fs_denied')

    // 白名单外语言：不经 sandbox。
    const before = portCalls.length
    const unsupported = await callTool('c5', 'invoke', {
      tool: 'shell',
      args: { mode: 'code', language: 'ruby', input: 'puts 1' },
      ...base,
    })
    assert.equal(unsupported.value.error.code, 'code_unsupported_language')
    assert.equal(portCalls.length, before, '白名单外语言不得触发 sandbox 调用')

    console.log('直连协议：describe + command/code + 密钥注入 + nonzero_exit + deny 档 fs_denied + 语言白名单')
  } finally {
    toolShell.stdin.end()
    sandbox.stdin.end()
    secrets.stdin.end()
    await Promise.all([waitExit(toolShell), waitExit(sandbox), waitExit(secrets)])
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-tool-shell-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    for (const [dir, identity] of [
      [SECRETS_DIR, 'secrets'],
      [SANDBOX_DIR, 'sandbox'],
      [TOOL_SHELL_DIR, 'tool-shell'],
    ]) {
      const packed = boot(root, ['pack', dir, '--identity', identity])
      assert.equal(packed.ok, true, `pack ${identity} 报告 ok:false`)
    }
    console.log('pack：secrets / sandbox / tool-shell ok')

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'secrets', path: SECRETS_DIR },
        { name: 'sandbox', path: SANDBOX_DIR },
        { name: 'tool-shell', path: TOOL_SHELL_DIR },
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

    const status = await waitForLoaded(root, ['secrets', 'sandbox', 'tool-shell'])
    console.log(`status：loaded = ${status.loaded.map((entry) => entry.id).join(', ')}`)

    const sandboxBin = join(root, 'state', 'deps', 'cargo-target', 'release', `sandbox${EXE}`)
    assert.ok(existsSync(sandboxBin), `sandbox 缓存二进制缺失：${sandboxBin}`)

    const seededBody = spawnSync(process.execPath, [SANDBOX_SEED, '--root', root], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    if (seededBody.status !== 0) {
      throw new Error(`seed 档位 body 失败：${seededBody.stderr || seededBody.stdout}`)
    }
    console.log('seed 档位映射 body：ok')

    // 本地密钥文件：真 secrets 服务经 CHRONO_PLUGIN_STATE 上溯到 <root>/state/secrets.local.json。
    writeFileSync(join(root, 'state', 'secrets.local.json'), JSON.stringify({ E2E_TOKEN: E2E_SECRET }))

    await directProtocolSmoke(
      join(TOOL_SHELL_DIR, 'execute', 'main.ts'),
      sandboxBin,
      join(root, 'state', 'plugins', 'secrets'),
    )

    const after = boot(root, ['status'])
    assert.ok(
      after.loaded.some((entry) => entry.id === 'tool-shell'),
      `seed 后 tool-shell 未装载：${JSON.stringify(after.loaded)}`,
    )

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, after.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const expected = JSON.parse(readFileSync(SANDBOX_BODY, 'utf8'))
    assert.deepEqual(projection.ids.sandbox.body, expected)
    assert.ok(projection.ids.secrets !== undefined, '投影缺 secrets 身份')
    assert.ok(projection.ids['tool-shell'] !== undefined, '投影缺 tool-shell 身份')
    console.log('离线投影：ids.sandbox.body = 档位映射默认 body，secrets / tool-shell 身份在册')

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
