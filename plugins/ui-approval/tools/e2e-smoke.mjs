// `ui-approval` 宿主装配冒烟（黑盒，经 boot CLI）：
// pack 入世树核对 → 临时 root seed（approval 先于 ui-approval，pins 才解析得到）→ start → 轮询 loaded →
// 声明 / 命令属主 / pins / `.worldignore` 核对 → `approval.list` 命令真实往返（服务反向调 #32）→
// `ui-approval.client.read` 交付客户端半边字节（插件自产自交付）→ stop → verify + replay。
// 失败路径同样尝试 stop 释放锁。用法：node plugins/ui-approval/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'
import { extractValue } from '../execute/bridge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const APPROVAL_DIR = join(REPO_ROOT, 'plugins', 'ui-approval')

/** 依赖先于本插件的 seed 顺序（pins 需在入世时解析到已存在的身份）。 */
const PACKAGES = ['approval', 'ui-approval']

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

async function waitFor(predicate, label, timeoutMs = 60000) {
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

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-approval-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    // 1) 入世树核对：契约文件与 execute/web/terms 入世，test/ 与 tools/、dist/ 排除。
    const worldignore = readWorldignore(APPROVAL_DIR)
    assert.equal(worldignore.ok, true, '.worldignore 解析失败')
    const source = packSourceDir(APPROVAL_DIR, worldignore.patterns)
    const packedPaths = collectPackedPaths(source.ops, source.rootTreeIndex)
    for (const required of [
      'plugin.json',
      'package.json',
      'package-lock.json',
      'README.md',
      'execute/main.ts',
      'execute/web/entry.tsx',
      'execute/web/model.ts',
      'execute/web/store.ts',
      'terms/approval.list.json',
      'terms/approval.decide.json',
      'terms/approval.decide_all.json',
      'terms/ui-approval.client.read.json',
    ]) {
      assert.ok(packedPaths.includes(required), `入世树缺 ${required}`)
    }
    assert.ok(!packedPaths.some((path) => path.startsWith('test/')), '入世树含 test/')
    assert.ok(!packedPaths.some((path) => path.startsWith('tools/')), '入世树含 tools/')
    assert.ok(!packedPaths.some((path) => path.startsWith('execute/web/dist/')), '入世树含构建产物 dist/')
    assert.ok(!packedPaths.some((path) => path.startsWith('schema/')), '零 schema 不应有 schema/')
    console.log(`入世树：ok（${packedPaths.length} 个文件，排除 test/ 与 tools/ 与 dist/）`)

    // 2) seed（依赖先入世，pins 才解析得到）
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(PACKAGES.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) })), null, 2),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, `seed 报告 ok:false：${JSON.stringify(seeded.items)}`)
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    // 3) start（含 plugin.json.build：npm ci + esbuild 产 dist）+ 轮询 loaded
    boot(root, ['start'])
    started = true
    await waitFor(() => {
      const status = boot(root, ['status'])
      return status.loaded.some((item) => item.id === 'ui-approval') && status.loaded.some((item) => item.id === 'approval')
    }, 'ui-approval + approval loaded')
    const status = boot(root, ['status'])
    assert.ok(status.loaded.some((item) => item.id === 'ui-approval'), 'ui-approval 未出现在 loaded')
    assert.ok(status.loaded.some((item) => item.id === 'approval'), 'approval 未出现在 loaded')
    console.log(`loaded: ${status.loaded.map((item) => item.id).join(' ')}`)

    // 4) 命令声明与属主
    const commands = boot(root, ['commands'])
    const listCommand = commands.find((command) => command.name === 'approval.list')
    const decideCommand = commands.find((command) => command.name === 'approval.decide')
    const decideAllCommand = commands.find((command) => command.name === 'approval.decide_all')
    const clientReadCommand = commands.find((command) => command.name === 'ui-approval.client.read')
    assert.ok(listCommand && decideCommand && decideAllCommand && clientReadCommand, 'commands 缺审批命令')
    for (const command of [listCommand, decideCommand, decideAllCommand, clientReadCommand]) {
      assert.equal(command.identity, 'ui-approval', `${command.name} 属主应为 ui-approval`)
    }
    console.log('commands：ok（approval.list / decide / decide_all / client.read 属主 ui-approval）')

    // 5) pins 声明与解析（seed 成功即解析成立；此处核对声明）
    const decl = JSON.parse(readFileSync(join(APPROVAL_DIR, 'plugin.json'), 'utf8'))
    assert.deepEqual(decl.pins, { approval: 'approval' })
    assert.equal(Object.hasOwn(decl, 'schema'), false, '零 schema：省略字段')
    assert.equal(Object.hasOwn(decl, 'exclusive'), false, '不再独占端口')
    assert.deepEqual(decl.implements, ['ui-approval'])
    console.log('pins / schema / exclusive：ok（pins={approval:approval}，零 schema，无独占端口）')

    // 6) `approval.list` 命令真实往返：入口 term → 服务 → 反向调 #32 list。
    const listValue = extractValue(boot(root, ['approval.list']))
    assert.equal(listValue.ok, true, `approval.list 非成功结果：${JSON.stringify(listValue)}`)
    assert.equal(listValue.pending, 0, JSON.stringify(listValue))
    assert.deepEqual(listValue.items, [], JSON.stringify(listValue))
    console.log('approval.list：ok（空队列，服务反向调 #32 成功）')

    // 7) `ui-approval.client.read` 交付客户端半边：插件自读包内 dist/entry.js 回字节。
    const readValue = extractValue(boot(root, ['ui-approval.client.read', JSON.stringify({ path: 'dist/entry.js' })]))
    assert.equal(readValue.path, 'dist/entry.js', JSON.stringify(readValue))
    assert.equal(typeof readValue.text, 'string', 'client.read 应回 text')
    assert.ok(readValue.text.includes('export'), 'entry.js 应是 ESM 产物')
    // 路径穿越防护：越界路径结构化拒（命令 result status refused）。
    const traversal = boot(root, ['ui-approval.client.read', JSON.stringify({ path: '../plugin.json' })])
    assert.equal(traversal.ok, false, '穿越路径应被拒')
    console.log('client.read：ok（dist/entry.js 读回，穿越路径拒绝）')

    // 8) stop → verify + replay
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
