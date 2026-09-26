// 手工核对：证明 Rust SDK 服务能在**非仓库**的临时宿主根下构建并起服务。
// 流程：造一个临时宿主根 → 物化目录放一个依赖 `../../plugin-sdk/rust` 的最小服务 →
// 用宿主真实的 `provisionRustPluginSdk` 供给 SDK crate → `cargo build --release --offline` →
// 起进程走 hello / call / drain 协议往返。用后清理临时根。
// 运行：`node tools/rust-sdk-temp-root-check.mjs`

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFrameDecoder, encodeFrame } from 'plugin-sdk'

import { provisionRustPluginSdk } from '../packages/host/assembly/sdk-provision.ts'

const CARGO_TOML = `[package]
name = "temp-probe"
version = "0.0.0"
edition = "2021"
publish = false

[[bin]]
name = "temp-probe"
path = "main.rs"

[dependencies]
plugin-sdk = { path = "../../plugin-sdk/rust" }
serde_json = "1"
`

const MAIN_RS = `// 最小 Rust SDK 服务：echo 方法，用于临时宿主根的构建 / 起服务核对。
use serde_json::Value;
use plugin_sdk::{run_service, shared_writer, ServiceError, ServiceHandler, ServiceSpec};

static SPEC: ServiceSpec = ServiceSpec {
    identity: "temp-probe",
    capability: "temp-probe",
    protocol: "1",
    state: "recomputable",
    methods: &["echo"],
};

struct Handler;

impl ServiceHandler for Handler {
    fn call(&self, _method: &str, args: &Value, _env: &Value) -> Result<Value, ServiceError> {
        Ok(args.clone())
    }
}

fn main() {
    run_service(&SPEC, std::io::stdin().lock(), shared_writer(std::io::stdout()), Handler);
}
`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

/** 在子进程 stdout 上等一帧；超时即失败。 */
function waitForFrame(decoder, buffer, timeoutMs) {
  return new Promise((resolveFrame, rejectFrame) => {
    const deadline = setTimeout(() => rejectFrame(new Error('frame timeout')), timeoutMs)
    const feed = () => {
      try {
        const frames = decoder.push(Buffer.from(buffer.splice(0)))
        if (frames.length > 0) {
          clearTimeout(deadline)
          resolveFrame(frames[0])
        }
      } catch (err) {
        clearTimeout(deadline)
        rejectFrame(err)
      }
    }
    buffer.feed = feed
    feed()
  })
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'chrono-rust-sdk-'))
  const cwd = join(root, 'state', 'runtime', 'materialized', 'f'.repeat(64))
  const targetDir = join(root, 'target')
  try {
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'Cargo.toml'), CARGO_TOML)
    writeFileSync(join(cwd, 'main.rs'), MAIN_RS)
    // 宿主侧供给：物化目录两级之上的 `plugin-sdk` 链接（非仓库根）。
    provisionRustPluginSdk(cwd)

    const build = spawnSync('cargo', ['build', '--release', '--offline'], {
      cwd,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: 'inherit',
    })
    if (build.status !== 0) return fail(`cargo build failed: ${build.status ?? build.error}`)

    const binary = join(targetDir, 'release', process.platform === 'win32' ? 'temp-probe.exe' : 'temp-probe')
    const child = spawn(binary, [], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
    const decoder = createFrameDecoder()
    const buffer = []
    child.stdout.on('data', (chunk) => {
      buffer.push(...chunk)
      buffer.feed?.()
    })

    child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'temp-probe' }))
    const manifest = await waitForFrame(decoder, buffer, 10_000)
    if (manifest.kind !== 'manifest' || manifest.identity !== 'temp-probe') {
      return fail(`unexpected manifest: ${JSON.stringify(manifest)}`)
    }

    child.stdin.write(
      encodeFrame({ v: '1', id: 'c', kind: 'call', port: 'temp-probe', method: 'echo', args: { ok: true } }),
    )
    const result = await waitForFrame(decoder, buffer, 10_000)
    if (result.kind !== 'result' || result.value?.ok !== true) {
      return fail(`unexpected result: ${JSON.stringify(result)}`)
    }

    child.stdin.write(encodeFrame({ v: '1', id: 'd', kind: 'drain', deadline_ms: 2000 }))
    const bye = await waitForFrame(decoder, buffer, 10_000)
    if (bye.kind !== 'bye') return fail(`unexpected bye: ${JSON.stringify(bye)}`)

    child.stdin.end()
    await new Promise((done) => child.once('exit', done))
    process.stdout.write('temp-root check passed: built and served under a non-repo host root\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  fail(err.stack ?? String(err))
})
