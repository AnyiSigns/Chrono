// launchNative：二进制候选路径口径与缺二进制 fail-closed（退出 127、只写 stderr）。

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { nativeBinaryCandidates } from '../launch.ts'

const SDK_URL = new URL('../index.ts', import.meta.url).href

const STATE = join(tmpdir(), 'chrono-root', 'state', 'plugins', 'toy')

describe('nativeBinaryCandidates', () => {
  it('共享 cargo 缓存优先，再回落包内 target/release', () => {
    const packageRoot = join(tmpdir(), 'pkg')
    expect(
      nativeBinaryCandidates({ binary: 'toy', packageRoot, pluginState: STATE, platform: 'linux' }),
    ).toEqual([
      resolve(STATE, '..', '..', 'deps', 'cargo-target', 'release', 'toy'),
      join(packageRoot, 'target', 'release', 'toy'),
    ])
  })

  it('无 ③ 目录时只回落包内 target/release；win32 加 .exe', () => {
    const packageRoot = join(tmpdir(), 'pkg')
    expect(nativeBinaryCandidates({ binary: 'toy', packageRoot, platform: 'win32' })).toEqual([
      join(packageRoot, 'target', 'release', 'toy.exe'),
    ])
  })
})

describe('launchNative', () => {
  it('缺二进制退出 127，且不污染 stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-sdk-launch-'))
    try {
      const script = join(dir, 'execute', 'launch.mjs')
      mkdirSync(dirname(script), { recursive: true })
      writeFileSync(
        script,
        `import { launchNative } from ${JSON.stringify(SDK_URL)}
launchNative({ binary: 'missing', logPrefix: 'toy' })
`,
      )
      const child = spawn(process.execPath, [script], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      const code = await new Promise<number | null>((resolveExit) =>
        child.once('exit', resolveExit),
      )
      expect(code).toBe(127)
      expect(stdout).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
