// 启动器：定位宿主依赖恢复产出的 Rust 二进制，以 stdio 直通拉起并透传退出码。
// 宿主以 CHRONO_PLUGIN_STATE=<root>/state/plugins/<id> 注入；cargo 产物落
// <root>/state/deps/cargo-target/release/（上溯两级 = <root>/state）。找不到再回落包内 target/release/。
// 只用 Node 内置模块，零 npm 依赖；随包入世。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const BIN = process.platform === 'win32' ? 'memory-retrieval.exe' : 'memory-retrieval'

const candidates = []
const state = process.env.CHRONO_PLUGIN_STATE
if (typeof state === 'string' && state.length > 0) {
  candidates.push(resolve(state, '..', '..', 'deps', 'cargo-target', 'release', BIN))
}
candidates.push(join(PKG_ROOT, 'target', 'release', BIN))

const exe = candidates.find((candidate) => existsSync(candidate))
if (exe === undefined) {
  process.stderr.write(`[memory-retrieval] launch: binary not found; looked in ${candidates.join(', ')}\n`)
  process.exit(127)
}

const child = spawn(exe, process.argv.slice(2), { stdio: 'inherit', windowsHide: true })
child.on('error', (err) => {
  process.stderr.write(`[memory-retrieval] launch: ${err.message}\n`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1))
})
