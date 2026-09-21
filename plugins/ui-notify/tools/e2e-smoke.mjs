// `ui-notify` 入世 + 宿主装配 E2E（黑盒，经 boot CLI）：
// pack 冒烟（零 schema + 成员仅 terms）→ 临时 root seed（ui-notify + config）→ start →
// 轮询 loaded（确认无服务进程）→ 写带 ui.notify 的 config body → 入站 command notify.state
// → stop → verify + replay。失败路径同样尝试 stop 释放锁。
// 用法：node plugins/ui-notify/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const UI_NOTIFY_DIR = join(REPO_ROOT, 'plugins', 'ui-notify')
const CONFIG_DIR = join(REPO_ROOT, 'plugins', 'config')

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

/** 读运维日志（JSONL）；文件缺失按空表。 */
function lifecycleRecords(root) {
  const file = join(root, 'state', 'lifecycle.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-notify-e2e-${stamp}`)
  const packRoot = join(tmpdir(), 'kilo', `chrono-ui-notify-pack-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(packRoot, 'state'), { recursive: true })
  let started = false
  try {
    // 1) 入世冒烟：零 schema + 成员仅 terms 可 pack
    const packed = boot(packRoot, ['pack', UI_NOTIFY_DIR, '--identity', 'ui-notify'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    console.log(`pack ui-notify: status=${packed.status} commit=${packed.commitHash}`)

    // 入世树核对：web/entry.js 随包入世（host.source.read 的读取对象），test/ 与 tools/ 不入世
    const worldignore = readWorldignore(UI_NOTIFY_DIR)
    assert.equal(worldignore.ok, true, '.worldignore 解析失败')
    const source = packSourceDir(UI_NOTIFY_DIR, worldignore.patterns)
    const packedPaths = collectPackedPaths(source.ops, source.rootTreeIndex)
    assert.ok(packedPaths.includes('web/entry.js'), `入世树缺 web/entry.js：${packedPaths.join(', ')}`)
    assert.ok(packedPaths.includes('terms/notify.state.json'), '入世树缺 terms/notify.state.json')
    assert.ok(packedPaths.includes('plugin.json'), '入世树缺 plugin.json')
    assert.ok(!packedPaths.some((path) => path.startsWith('test/')), '入世树含 test/')
    assert.ok(!packedPaths.some((path) => path.startsWith('tools/')), '入世树含 tools/')
    console.log(`入世树：ok（${packedPaths.length} 个文件，含 web/entry.js，排除 test/ 与 tools/）`)

    // 2) seed（ui-notify + config）
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'ui-notify', path: UI_NOTIFY_DIR },
        { name: 'config', path: CONFIG_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    // 3) start + 轮询 loaded
    boot(root, ['start'])
    started = true
    await waitFor(
      () => boot(root, ['status']).loaded.some((item) => item.id === 'ui-notify'),
      'ui-notify loaded',
    )
    const status = boot(root, ['status'])
    const loaded = status.loaded.find((item) => item.id === 'ui-notify')
    assert.ok(loaded, 'ui-notify 未出现在 loaded')
    assert.match(loaded.gen, /^[0-9a-f]{64}$/)
    console.log(`loaded: ${status.loaded.map((item) => item.id).join(' ')}`)

    // 无服务进程：运维日志里不得有 ui-notify 的 service 记录（起 / 停 / 失败）
    const serviceRecords = lifecycleRecords(root).filter((record) => record.impl === 'ui-notify' && record.kind === 'service')
    assert.deepEqual(serviceRecords, [], `ui-notify 不应有 service 记录：${JSON.stringify(serviceRecords)}`)
    console.log('无服务进程：ok（无 ui-notify service 运维记录）')

    // 4) 命令已声明
    const commands = boot(root, ['commands'])
    const notifyCommand = commands.find((command) => command.name === 'notify.state')
    assert.ok(notifyCommand, 'commands 缺 notify.state')
    assert.equal(notifyCommand.identity, 'ui-notify')
    console.log('commands：ok（notify.state 属主 ui-notify）')

    // 5) 写带 ui.notify 的 config body（数据世代）
    const defaultBody = JSON.parse(readFileSync(join(CONFIG_DIR, 'tools', 'default-body.json'), 'utf8'))
    const body = {
      ...defaultBody,
      ui: {
        ...defaultBody.ui,
        notify: {
          approval_pending: false,
          run_finished: true,
          orchestration_unhealthy: false,
          only_when_unfocused: false,
        },
      },
    }
    const expectPos = boot(root, ['status']).world_head.hash
    const directive = [
      {
        kind: 'write',
        request: {
          id: 'e2e-config-notify',
          op: 'batch',
          target: { expect_pos: expectPos },
          args: {
            ops: [
              { op: 'put', args: { body } },
              { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
          by: 'e2e',
        },
      },
    ]
    const written = boot(root, ['run', JSON.stringify(directive)])
    assert.equal(written.status, 'done', `写入未完成：${JSON.stringify(written)}`)
    console.log('config body 写入：done')

    // 6) 入站 command notify.state 读回整份 config body
    const state = boot(root, ['notify.state'])
    const value = state.observations[0].value
    assert.equal(value.version, 1)
    assert.equal(value.permission, 'review')
    assert.equal(value.ui.notify.approval_pending, false)
    assert.equal(value.ui.notify.run_finished, true)
    assert.equal(value.ui.notify.orchestration_unhealthy, false)
    assert.equal(value.ui.notify.only_when_unfocused, false)
    console.log('notify.state：ok（返回整份 config body，含 ui.notify 开关）')

    // 7) stop → verify + replay
    const beforeStop = boot(root, ['status'])
    boot(root, ['stop'])
    started = false
    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, beforeStop.world_head, 'replay 链头与 status 不一致')
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
