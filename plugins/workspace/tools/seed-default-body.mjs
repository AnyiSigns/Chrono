// 预置 workspace 默认 body（数据世代）：把宿主根 realpath 作为首个工作区，首启零摩擦。
// id 由宿主根 realpath 确定性派生（sha256 前 12 位）——同根重复执行命中幂等短路，不取时间 / 随机。
// 模板住同目录 default-body.json（占位符在对象上替换，避免把路径拼进 JSON 文本）。
// 前置：宿主已 start（唯一写者）。用法：node plugins/workspace/tools/seed-default-body.mjs --root <宿主根目录>
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')

/** 归一 `\\?\` / `\\?\UNC\` verbatim 前缀，与 Rust 侧 normalize_canonical 同口径。 */
function stripVerbatim(text) {
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice(8)}`
  if (text.startsWith('\\\\?\\')) return text.slice(4)
  return text
}

function workspaceId(realPath) {
  return createHash('sha256').update(realPath).digest('hex').slice(0, 12)
}

function rootArg() {
  const argv = process.argv.slice(2)
  const index = argv.indexOf('--root')
  if (index < 0 || argv[index + 1] === undefined) throw new Error('缺少 --root <宿主根目录>')
  return resolve(argv[index + 1])
}

function boot(root, args) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
  if (result.status !== 0) {
    throw new Error(`boot ${args[0]} 失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

function main() {
  const root = rootArg()
  const real = stripVerbatim(realpathSync.native(root))
  const id = workspaceId(real)
  const name = basename(real)
  const template = JSON.parse(readFileSync(join(HERE, 'default-body.json'), 'utf8'))
  const body = {
    ...template,
    workspaces: template.workspaces.map((entry) => ({
      ...entry,
      id: entry.id.replace('${WORKSPACE_ID}', id),
      name: entry.name.replace('${WORKSPACE_NAME}', name),
      path: entry.path.replace('${WORKSPACE_PATH}', real),
    })),
  }
  const status = boot(root, ['status'])
  const directive = [
    {
      kind: 'write',
      request: {
        id: 'workspace-default-body',
        op: 'batch',
        target: { expect_pos: status.world_head.hash },
        args: {
          ops: [
            { op: 'put', args: { body } },
            {
              op: 'add_gen',
              args: { id: 'workspace', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} },
            },
          ],
        },
        by: 'seed-default',
      },
    },
  ]
  const result = boot(root, ['run', JSON.stringify(directive)])
  if (result.status !== 'done') throw new Error(`写入未完成：${JSON.stringify(result)}`)
  process.stdout.write(
    `${JSON.stringify({ ok: true, identity: 'workspace', status: result.status, workspace_id: id, path: real })}\n`,
  )
}

main()
