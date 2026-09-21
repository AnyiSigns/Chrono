// `ui-shell` 宿主装配 + HTTP E2E（黑盒，经 boot CLI）：
// pack 冒烟 → 临时 root seed（ui-shell + input + config）→ start → 轮询 loaded →
// HTTP 请求（/、三份静态资源、/api/command config.read 真实往返、/events SSE、/api/submit 写 input 槽）
// → stop → verify + replay → 离线投影核对落账。
// 用法：node plugins/ui-shell/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
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
const UI_SHELL_DIR = join(REPO_ROOT, 'plugins', 'ui-shell')
const INPUT_DIR = join(REPO_ROOT, 'plugins', 'input')
const CONFIG_DIR = join(REPO_ROOT, 'plugins', 'config')
const UI_NOTIFY_DIR = join(REPO_ROOT, 'plugins', 'ui-notify')

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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function httpCall(port, method, path, body) {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = payload === null ? {} : { 'content-type': 'application/json', 'content-length': payload.length }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolveCall({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/** 打开 SSE 流：`ready` 在响应到达时兑现，`result` 在匹配 predicate 的记录出现时兑现。 */
function openSse(port, predicate, timeoutMs = 10000) {
  let markReady
  const ready = new Promise((resolveReady) => {
    markReady = resolveReady
  })
  const result = new Promise((resolveResult, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      markReady()
      let buffer = ''
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error(`SSE 超时；已收到：${buffer.slice(0, 800)}`))
      }, timeoutMs)
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const records = buffer
          .split('\n\n')
          .map((part) => {
            const line = part.split('\n').find((entry) => entry.startsWith('data: '))
            if (line === undefined) return null
            try {
              return JSON.parse(line.slice('data: '.length))
            } catch {
              return null
            }
          })
          .filter((record) => record !== null)
        const found = records.find(predicate)
        if (found !== undefined) {
          clearTimeout(timer)
          req.destroy()
          resolveResult({ records, found })
        }
      })
      res.on('error', () => {})
    })
    req.on('error', reject)
  })
  return { ready, result }
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
  const root = join(tmpdir(), 'kilo', `chrono-ui-shell-e2e-${stamp}`)
  const packRoot = join(tmpdir(), 'kilo', `chrono-ui-shell-pack-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(packRoot, 'state'), { recursive: true })
  const port = await freePort()
  const env = { ...process.env, CHRONO_UI_PORT: String(port) }
  let started = false
  try {
    // 入世冒烟：单目录 pack
    const packed = boot(packRoot, ['pack', UI_SHELL_DIR, '--identity', 'ui-shell'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    console.log(`pack: status=${packed.status} commit=${packed.commitHash}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'ui-shell', path: UI_SHELL_DIR },
        { name: 'input', path: INPUT_DIR },
        { name: 'config', path: CONFIG_DIR },
        { name: 'ui-notify', path: UI_NOTIFY_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'], env)
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'], env)
      return status.loaded.some((item) => item.id === 'ui-shell')
    }, 'ui-shell loaded')
    console.log('start + 握手：ok（ui-shell 已装载）')

    // 等壳 HTTP 就绪 + 入站连接建立
    const stateDeadline = Date.now() + 20000
    for (;;) {
      try {
        const response = await httpCall(port, 'GET', '/api/state')
        const state = JSON.parse(response.body)
        if (state.connected === true) break
      } catch {
        // 壳尚未监听
      }
      if (Date.now() > stateDeadline) throw new Error(`timeout: 壳 /api/state connected（port=${port}）`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    }
    console.log('壳 HTTP + 入站连接：ok')

    // 页面与三份静态资源
    const page = await httpCall(port, 'GET', '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /shell-root/)
    assert.match(page.body, /__CHRONO_SHELL__/)
    const tokens = await httpCall(port, 'GET', '/assets/tokens.v1.css')
    assert.equal(tokens.status, 200)
    assert.match(tokens.body, /--c-bg/)
    assert.match(tokens.body, /--z-toast/)
    const icons = await httpCall(port, 'GET', '/assets/icons.v1.svg')
    assert.equal(icons.status, 200)
    assert.match(icons.body, /<symbol id="alert-triangle"/)
    const messages = await httpCall(port, 'GET', '/assets/messages.v1.json')
    assert.equal(messages.status, 200)
    assert.equal(typeof JSON.parse(messages.body).unknown.title, 'string')
    const favicon = await httpCall(port, 'GET', '/favicon.svg')
    assert.equal(favicon.status, 200)
    const shellJs = await httpCall(port, 'GET', '/assets/lib/shell.js')
    assert.equal(shellJs.status, 200)
    assert.match(String(shellJs.headers['content-type']), /javascript/)
    // headless 入口：壳经 host.source.read 取字节后以同源路径服务 200（首载可能竞态，轮询）
    let headless = null
    const headlessDeadline = Date.now() + 15000
    for (;;) {
      headless = await httpCall(port, 'GET', '/assets/headless/ui-notify.js')
      if (headless.status === 200 && headless.body.includes('__chronoNotify')) break
      if (Date.now() > headlessDeadline) {
        throw new Error(`headless 入口未就绪（status=${headless.status}）：${headless.body.slice(0, 200)}`)
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    }
    console.log('HTTP 静态资源：ok（/、tokens、icons、messages、favicon、lib、headless 200）')

    // 入站桥真实往返：config.read
    const read = await httpCall(port, 'POST', '/api/command', { name: 'config.read', args: null })
    assert.equal(read.status, 200, read.body)
    const readBody = JSON.parse(read.body)
    assert.equal(readBody.ok, true, read.body)
    assert.equal(readBody.kind, 'result')
    assert.ok(readBody.status === 'done' || readBody.status === 'idle', `config.read status=${readBody.status}`)
    console.log('入站桥往返：ok（command config.read 真实经宿主返回）')

    // 防护：config 尚无数据世代（body 为代码回落 tree）时，/api/theme 拒绝写、不擦配置
    const guarded = await httpCall(port, 'POST', '/api/theme', { theme: 'dark' })
    assert.equal(guarded.status, 409, guarded.body)
    assert.equal(JSON.parse(guarded.body).code, 'bad_directive', guarded.body)
    console.log('主题防护：ok（config body 为 tree 回落时拒写 409）')

    // 写入 config 默认数据 body（数据世代）后再切主题
    const defaultBody = JSON.parse(readFileSync(join(CONFIG_DIR, 'tools', 'default-body.json'), 'utf8'))
    const expectPos = boot(root, ['status'], env).world_head.hash
    const configDirective = [
      {
        kind: 'write',
        request: {
          id: 'e2e-config-default',
          op: 'batch',
          target: { expect_pos: expectPos },
          args: {
            ops: [
              { op: 'put', args: { body: defaultBody } },
              { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
          by: 'e2e',
        },
      },
    ]
    const configWritten = boot(root, ['run', JSON.stringify(configDirective)], env)
    assert.equal(configWritten.status, 'done', `config 写入未完成：${JSON.stringify(configWritten)}`)
    console.log('config 默认 body 写入：done')

    // 主题：读-改-写 config.ui.theme（config 词表 day/night，DOM 词表 light/dark），并经 config.read 复核
    const themed = await httpCall(port, 'POST', '/api/theme', { theme: 'dark' })
    assert.equal(themed.status, 200, themed.body)
    assert.equal(JSON.parse(themed.body).ok, true, themed.body)
    const themeDeadline = Date.now() + 15000
    let themeValue = null
    for (;;) {
      const response = await httpCall(port, 'POST', '/api/command', { name: 'config.read', args: null })
      const parsed = JSON.parse(response.body)
      themeValue = parsed.ok ? parsed.value : null
      if (themeValue && themeValue.ui && themeValue.ui.theme === 'night') break
      if (Date.now() > themeDeadline) throw new Error(`theme 未落账：${response.body}`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    }
    const shellState = JSON.parse((await httpCall(port, 'GET', '/api/state')).body)
    assert.equal(shellState.theme, 'dark')
    console.log('主题：ok（/api/theme 写 config.ui.theme 并生效）')

    // 资产：asset.put → 引用；asset.get 回字节
    const assetBytes = Buffer.from('chrono', 'utf8').toString('base64')
    const assetPut = await httpCall(port, 'POST', '/api/asset', { mime: 'text/plain', bytes: assetBytes })
    assert.equal(assetPut.status, 200, assetPut.body)
    const assetRef = JSON.parse(assetPut.body).ref
    assert.match(assetRef.sha256, /^[0-9a-f]{64}$/)
    const assetGet = await httpCall(port, 'GET', `/api/asset?sha256=${assetRef.sha256}`)
    assert.equal(assetGet.status, 200, assetGet.body)
    assert.equal(JSON.parse(assetGet.body).bytes, assetBytes)
    console.log('资产：ok（asset.put / asset.get 真实往返）')

    // cancel：未知 run 原样回 unknown_run
    const cancel = await httpCall(port, 'POST', '/api/cancel', { run: 'no-such-run' })
    assert.equal(cancel.status, 502, cancel.body)
    assert.equal(JSON.parse(cancel.body).code, 'unknown_run')
    console.log('cancel：ok（unknown_run 透传）')

    // SSE：宿主事件重播
    const sse = openSse(port, (record) => record.topic === 'run.started' || record.topic === 'run.finished')
    await sse.ready
    await httpCall(port, 'POST', '/api/command', { name: 'config.read', args: null })
    const sseResult = await sse.result
    assert.equal(sseResult.found.impl, 'host')
    console.log(`SSE：ok（收到宿主事件 ${sseResult.found.topic}）`)

    // 写 input 槽并验证落账
    const before = boot(root, ['status'], env)
    const directive = {
      kind: 'write',
      request: {
        op: 'batch',
        args: {
          ops: [
            { op: 'put', args: { body: { slots: { _main: { kind: 'idle' } } } } },
            {
              op: 'add_gen',
              args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} },
            },
          ],
        },
      },
    }
    const submitted = await httpCall(port, 'POST', '/api/submit', { directive, thread: '_main' })
    assert.equal(submitted.status, 202, submitted.body)
    const submitBody = JSON.parse(submitted.body)
    assert.equal(submitBody.ok, true, submitted.body)
    assert.equal(typeof submitBody.run, 'string')
    await waitFor(() => {
      const current = boot(root, ['status'], env)
      return current.world_head.hash !== before.world_head.hash
    }, 'input 写落账（链头推进）')
    console.log('入站桥 submit：ok（写 input 槽、链头推进）')

    const status = boot(root, ['status'], env)
    boot(root, ['stop'], env)
    started = false

    const verified = boot(root, ['verify'], env)
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'], env)
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    // 离线投影：input 槽已落账
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const input = projection.ids['input']
    assert.ok(input, '投影缺 input')
    assert.equal(input.body.slots._main.kind, 'idle', `input 槽未落账：${JSON.stringify(input.body)}`)
    assert.equal(projection.ids['ui-shell'].pins.host, 'host')
    console.log('离线投影：ok（input.slots._main.kind=idle、ui-shell.pins.host=host）')

    // 挂载表 / headless 清单已生成
    const mountsFile = join(root, 'state', 'ui-mounts.json')
    const headlessFile = join(root, 'state', 'ui-headless.json')
    assert.equal(existsSync(mountsFile), true, '缺 state/ui-mounts.json')
    assert.equal(existsSync(headlessFile), true, '缺 state/ui-headless.json')
    const mounts = JSON.parse(readFileSync(mountsFile, 'utf8'))
    assert.equal(mounts.length, 6)
    console.log('挂载表 / headless 清单：ok')

    console.log(`E2E ok（root=${root}，port=${port}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'], env)
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
