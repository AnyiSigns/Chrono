// `ui-composer` 宿主装配冒烟（黑盒，经 boot CLI）：
// pack 入世树核对 → 临时 root seed（ui-composer + input + config）→ start → 轮询 loaded →
// 命令 / 提交经子应用 HTTP 真实往返 → 宿主事件经本插件 SSE 转发 → stop → verify + replay。
// 失败路径同样尝试 stop 释放锁。用法：node plugins/ui-composer/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const COMPOSER_DIR = join(REPO_ROOT, 'plugins', 'ui-composer')
const INPUT_DIR = join(REPO_ROOT, 'plugins', 'input')
const CONFIG_DIR = join(REPO_ROOT, 'plugins', 'config')

/** 依赖先于本插件的 seed 顺序（本插件无 pins，input / config 供命令面往返）。 */
const PACKAGES = ['input', 'config', 'ui-composer']

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
    throw new Error(
      `boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`,
    )
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
    const headers = { origin: `http://127.0.0.1:${port}` }
    if (payload !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
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
        reject(new Error(`SSE 超时；已收到：${buffer.slice(0, 600)}`))
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
          resolveResult(found)
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
      if (
        entry.mode === 'dir' &&
        entry.hash !== null &&
        typeof entry.hash === 'object' &&
        Number.isInteger(entry.hash.$n)
      ) {
        walk(entry.hash.$n, path)
      } else if (entry.mode === 'file') {
        paths.push(path)
      }
    }
  }
  walk(rootIndex, '')
  return paths
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-composer-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  const port = await freePort()
  const env = { ...process.env, CHRONO_UI_PORT_UI_COMPOSER: String(port) }
  let started = false
  try {
    // 1) 入世树核对：契约文件与 execute/web 入世，test/ 与 tools/ 排除。
    const worldignore = readWorldignore(COMPOSER_DIR)
    assert.equal(worldignore.ok, true, '.worldignore 解析失败')
    const source = packSourceDir(COMPOSER_DIR, worldignore.patterns)
    const packedPaths = collectPackedPaths(source.ops, source.rootTreeIndex)
    for (const required of [
      'plugin.json',
      'package.json',
      'README.md',
      'execute/main.ts',
      'execute/web/entry.js',
      'execute/web/model.js',
      'execute/web/run-model.js',
      'execute/web/attach.js',
      'execute/web/dropdown.js',
    ]) {
      assert.ok(packedPaths.includes(required), `入世树缺 ${required}`)
    }
    assert.ok(!packedPaths.some((path) => path.startsWith('test/')), '入世树含 test/')
    assert.ok(!packedPaths.some((path) => path.startsWith('tools/')), '入世树含 tools/')
    assert.ok(!packedPaths.some((path) => path.startsWith('schema/')), '零 schema 不应有 schema/')
    console.log(`入世树：ok（${packedPaths.length} 个文件，排除 test/ 与 tools/）`)

    // 2) seed（input / config 供命令面往返）
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(
        PACKAGES.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) })),
        null,
        2,
      ),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, `seed 报告 ok:false：${JSON.stringify(seeded.items)}`)
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    // 3) start + 轮询 loaded
    boot(root, ['start'], env)
    started = true
    await waitFor(() => {
      const status = boot(root, ['status'], env)
      const loaded = status.loaded.map((item) => item.id)
      return ['ui-composer', 'input', 'config'].every((id) => loaded.includes(id))
    }, 'ui-composer + input + config loaded')
    const status = boot(root, ['status'], env)
    console.log(`loaded: ${status.loaded.map((item) => item.id).join(' ')}`)

    // 4) 声明核对：本插件无命令、无 pins、零 schema
    const commands = boot(root, ['commands'], env)
    assert.ok(
      !commands.some((command) => command.identity === 'ui-composer'),
      `ui-composer 不应声明命令：${JSON.stringify(commands)}`,
    )
    const decl = JSON.parse(readFileSync(join(COMPOSER_DIR, 'plugin.json'), 'utf8'))
    assert.deepEqual(decl.pins, {})
    assert.deepEqual(decl.commands, [])
    assert.equal(Object.hasOwn(decl, 'schema'), false, '零 schema：省略字段')
    console.log('声明：ok（pins 空 / 无命令 / 零 schema）')

    // 5) 子应用 HTTP 就绪 + 入站连接
    const stateDeadline = Date.now() + 20000
    for (;;) {
      try {
        const response = await httpCall(port, 'GET', '/api/state')
        const state = JSON.parse(response.body)
        if (state.ok === true && state.connected === true) break
      } catch {
        // 尚未监听
      }
      if (Date.now() > stateDeadline)
        throw new Error(`timeout: 子应用 /api/state connected（port=${port}）`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    }
    console.log('子应用 HTTP + 入站连接：ok')

    // 6) 入口与静态模块 / 穿越
    const entry = await httpCall(port, 'GET', '/entry.js')
    assert.equal(entry.status, 200)
    assert.match(entry.body, /export async function mount/)
    assert.match(String(entry.headers['content-type']), /javascript/)
    for (const name of [
      'entry.js',
      'model.js',
      'run-model.js',
      'client.js',
      'sse.js',
      'attach.js',
      'dropdown.js',
      'dom.js',
      'styles.js',
      'messages.js',
    ]) {
      const response = await httpCall(port, 'GET', `/${name}`)
      assert.equal(response.status, 200, `${name} 应 200`)
    }
    const traversal = await httpCall(port, 'GET', '/../plugin.json')
    assert.equal(traversal.status, 404)
    console.log('HTTP 静态模块：ok（视图层模块 200、穿越 404）')

    // 7) 命令真实往返：input.read / config.read
    const inputRead = await httpCall(port, 'POST', '/api/command', {
      name: 'input.read',
      args: { thread: '_main' },
    })
    assert.equal(inputRead.status, 200, inputRead.body)
    const inputValue = JSON.parse(inputRead.body).value
    assert.ok(inputValue !== null && typeof inputValue === 'object', inputRead.body)
    const configRead = await httpCall(port, 'POST', '/api/command', {
      name: 'config.read',
      args: null,
    })
    assert.equal(configRead.status, 200, configRead.body)
    const configValue = JSON.parse(configRead.body).value
    assert.ok(configValue !== null && typeof configValue === 'object', configRead.body)
    console.log('命令往返：ok（input.read / config.read）')

    // 8) SSE：宿主 run 事件经本插件转发
    const sse = openSse(
      port,
      (record) => record.topic === 'run.started' || record.topic === 'run.finished',
    )
    await sse.ready
    await httpCall(port, 'POST', '/api/command', { name: 'input.read', args: { thread: '_main' } })
    const sseResult = await sse.result
    assert.equal(sseResult.impl, 'host')
    console.log(`SSE：ok（收到宿主事件 ${sseResult.topic}）`)

    // 9) 提交：写 input 槽（read-modify-write 形状）被接受
    const submit = await httpCall(port, 'POST', '/api/submit', {
      directives: [
        {
          kind: 'write',
          request: {
            op: 'batch',
            args: {
              ops: [
                {
                  op: 'put',
                  args: {
                    body: {
                      slots: { _main: { kind: 'chat.message', text: 'e2e', attachments: [] } },
                    },
                  },
                },
                {
                  op: 'add_gen',
                  args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} },
                },
              ],
            },
          },
        },
      ],
      thread: '_main',
    })
    assert.equal(submit.status, 202, submit.body)
    console.log('提交：ok（input 槽写指令被接受）')

    // 10) stop → verify + replay
    const beforeStop = boot(root, ['status'], env)
    boot(root, ['stop'], env)
    started = false
    const verified = boot(root, ['verify'], env)
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'], env)
    assert.deepEqual(replayed.head, beforeStop.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    console.log(`E2E ok（root=${root}，port=${port}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'], env)
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 4) console.error(`清理临时 root 失败（不影响结果）：${err.message}`)
        else await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
      }
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
