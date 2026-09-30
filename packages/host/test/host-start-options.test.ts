// 启动选项非法收口（进程级）：所有非法入口选项（超时 / watcher / 包装器 / 未知参数）
// 一律 fail-closed 退出码 1，并记一条 host.start_failed（reason = 规范错误前缀）。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { readLifecycle } from './test-helpers-ext.ts'

const HOST_MAIN = fileURLToPath(new URL('../main.ts', import.meta.url))

/** 起一次宿主入口子进程；显式清空另两项 env，避免宿主环境影响判定。 */
function runMain(
  root: string,
  env: Record<string, string>,
  extraArgs: string[] = [],
): Promise<number | null> {
  const child = spawn(process.execPath, [HOST_MAIN, '--root', root, ...extraArgs], {
    env: {
      ...process.env,
      CHRONO_CALL_TIMEOUT_MS: '',
      CHRONO_START_WRAPPER: '',
      CHRONO_WATCH: '',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: root,
  })
  return new Promise((resolve) => child.once('exit', resolve))
}

describe('启动选项非法收口（宿主入口）', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  const cases: Array<{ name: string; env: Record<string, string>; reason: string }> = [
    {
      name: 'CHRONO_CALL_TIMEOUT_MS 非法',
      env: { CHRONO_CALL_TIMEOUT_MS: '0' },
      reason: 'bad_call_timeout',
    },
    { name: 'CHRONO_WATCH 无法识别', env: { CHRONO_WATCH: 'maybe' }, reason: 'bad_watch' },
    {
      name: 'CHRONO_START_WRAPPER 纯空白',
      env: { CHRONO_START_WRAPPER: '   ' },
      reason: 'bad_start_wrapper',
    },
  ]

  for (const item of cases) {
    it(`${item.name} → 退出码 1 + host.start_failed(${item.reason})`, async () => {
      const code = await runMain(root, item.env)
      expect(code).toBe(1)
      expect(readLifecycle(hostPaths(root).lifecycleFile)).toContainEqual(
        expect.objectContaining({ kind: 'host', event: 'start_failed', reason: item.reason }),
      )
    }, 15_000)
  }

  it('未知入口参数 → 退出码 1 + host.start_failed，不静默忽略', async () => {
    const code = await runMain(root, {}, ['--bogus'])
    expect(code).toBe(1)
    expect(readLifecycle(hostPaths(root).lifecycleFile)).toContainEqual(
      expect.objectContaining({
        kind: 'host',
        event: 'start_failed',
        reason: 'unknown_entry_arg',
      }),
    )
  }, 15_000)
})
