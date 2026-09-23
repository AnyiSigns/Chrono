// `ui-sidebar` 入世冒烟（黑盒，经 boot CLI）：pack 入世树核对 → 单目录 pack → 批量 seed
// （input / session / workspace / ui-sidebar，pins 需在入世时解析到已存在身份）→ verify。
// 验证声明 / 命令 / pins / `.worldignore`：全部离线，不起宿主服务（workspace 为 Rust，起服务需物化构建）。
// 用法：node plugins/ui-sidebar/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const SIDEBAR_DIR = join(REPO_ROOT, 'plugins', 'ui-sidebar')

/** 依赖先于本插件的 seed 顺序（pins 需在入世时解析到已存在的身份）。 */
const PACKAGES = ['input', 'session', 'workspace', 'ui-sidebar']

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

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-sidebar-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  try {
    // 1) 入世树核对：契约文件与 execute/web/terms 入世，test/ 与 tools/ 排除。
    const worldignore = readWorldignore(SIDEBAR_DIR)
    assert.equal(worldignore.ok, true, '.worldignore 解析失败')
    const source = packSourceDir(SIDEBAR_DIR, worldignore.patterns)
    const packedPaths = collectPackedPaths(source.ops, source.rootTreeIndex)
    for (const required of [
      'plugin.json',
      'package.json',
      'README.md',
      'tsconfig.json',
      'execute/main.js',
      'execute/methods.js',
      'execute/build.mjs',
      'execute/web/entry.tsx',
      'execute/web/badges.ts',
      'execute/web/sidebar-model.ts',
      'terms/session.new.json',
      'terms/session.branch.json',
      'terms/workspace.reveal.json',
      'terms/client.read.json',
    ]) {
      assert.ok(packedPaths.includes(required), `入世树缺 ${required}`)
    }
    assert.ok(!packedPaths.some((path) => path.startsWith('test/')), '入世树含 test/')
    assert.ok(!packedPaths.some((path) => path.startsWith('tools/')), '入世树含 tools/')
    assert.ok(!packedPaths.some((path) => path.startsWith('execute/web/dist/')), '入世树含构建产物 dist/')
    console.log(`入世树：ok（${packedPaths.length} 个文件，排除 test/ / tools/ / execute/web/dist/）`)

    // 2) 声明 / 命令 / pins 核对（契约字段，离线读 plugin.json）。
    const decl = JSON.parse(readFileSync(join(SIDEBAR_DIR, 'plugin.json'), 'utf8'))
    assert.equal(decl.identity, 'ui-sidebar')
    assert.equal(decl.start, 'node execute/main.js')
    assert.equal(Object.hasOwn(decl, 'schema'), false, 'UI 插件应零 schema（省略字段）')
    assert.deepEqual(decl.implements, ['ui-sidebar'])
    assert.deepEqual(decl.pins, { session: 'session', workspace: 'workspace' })
    assert.deepEqual(decl.members, [
      { kind: 'execute', path: 'execute/' },
      { kind: 'term', path: 'terms/' },
    ])
    assert.deepEqual(decl.commands.map((command) => command.name), [
      'session.new',
      'session.select',
      'session.rename',
      'session.delete',
      'session.restore',
      'session.branch',
      'workspace.list',
      'workspace.pick',
      'workspace.add',
      'workspace.remove',
      'workspace.reveal',
      'ui-sidebar.client.read',
    ])
    assert.equal(Object.hasOwn(decl, 'exclusive'), false, 'HTTP 面作废后不应再声明 exclusive')
    assert.equal(decl.commands.find((command) => command.name === 'ui-sidebar.client.read').readonly, true)
    for (const command of decl.commands) {
      const term = JSON.parse(readFileSync(join(SIDEBAR_DIR, command.entry), 'utf8'))
      assert.equal(term[0], 'eff')
      assert.equal(term[1], 'ui-sidebar')
    }
    console.log(`声明 / 命令：ok（12 条命令入口 term 齐全；pins=session+workspace）`)

    // 3) 批量 seed：依赖先入世，ui-sidebar 的 pins 才能在入世时解析（同一原子批内解析）。
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(PACKAGES.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) })), null, 2),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, `seed 报告 ok:false：${JSON.stringify(seeded.items)}`)
    const sidebarItem = seeded.items.find((item) => item.name === 'ui-sidebar')
    assert.ok(sidebarItem, 'seed 报告缺 ui-sidebar')
    assert.equal(sidebarItem.identity, 'ui-sidebar')
    assert.ok(sidebarItem.status === 'seeded' || sidebarItem.status === 'unchanged', `ui-sidebar seed 状态异常：${sidebarItem.status}`)
    console.log(`seed：${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    // 4) 单目录 pack（身份名与包内一致 → 已入世为 unchanged；同目录同身份产出相同 tree）。
    const packed = boot(root, ['pack', SIDEBAR_DIR, '--identity', 'ui-sidebar'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    assert.equal(packed.identity, 'ui-sidebar')
    assert.ok(packed.status === 'packed' || packed.status === 'unchanged', `pack 状态异常：${packed.status}`)
    console.log(`pack：ok（identity=${packed.identity}，status=${packed.status}）`)

    // 4b) 身份名不一致 → fail-closed 拒绝（identity_mismatch）。
    const mismatch = spawnSync(process.execPath, [BOOT_MAIN, 'pack', SIDEBAR_DIR, '--identity', 'not-ui-sidebar', '--root', root], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    assert.notEqual(mismatch.status, 0, '身份名不一致应退出码非 0')
    assert.match(`${mismatch.stdout}${mismatch.stderr}`, /identity_mismatch/, '应报 identity_mismatch')
    console.log('pack 身份不一致：ok（identity_mismatch 拒绝）')

    // 5) verify：链自洽。
    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    console.log('verify：ok')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

try {
  main()
} catch (err) {
  console.error(err.stack || err.message)
  process.exitCode = 1
}
