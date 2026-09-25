// 预置 workspace 默认清单（运行记录，已出世界）：把宿主根 realpath 作为首个工作区，首启零摩擦。
// 直接追加写入 owner ④ 追加日志 `state/data/workspace/workspace.jsonl`（离线，宿主须已停）；
// id 由宿主根 realpath 确定性派生（sha256 前 12 位）——同根重复执行命中内容幂等（服务重放取最后一条 body）。
// 模板住同目录 default-body.json（占位符在对象上替换，避免把路径拼进 JSON 文本）。
// 用法：node plugins/workspace/tools/seed-default-body.mjs --root <宿主根目录>
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

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

function main() {
  const root = rootArg()
  const real = stripVerbatim(realpathSync.native(root))
  const id = workspaceId(real)
  const name = basename(real)
  const template = JSON.parse(readFileSync(join(HERE, 'default-body.json'), 'utf8'))
  const body = {
    version: 1,
    workspaces: template.workspaces.map((entry) => ({
      id: entry.id.replace('${WORKSPACE_ID}', id),
      name: entry.name.replace('${WORKSPACE_NAME}', name),
      path: entry.path.replace('${WORKSPACE_PATH}', real),
    })),
  }
  const dir = join(root, 'state', 'data', 'workspace')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'workspace.jsonl')
  if (!existsSync(file)) {
    appendFileSync(file, `${JSON.stringify({ t: 'body', run: null, body })}\n`, 'utf8')
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, identity: 'workspace', workspace_id: id, path: real })}\n`,
  )
}

main()
