// boot CLI 薄封装：pack / seed / start / status / stop / verify / replay。
// 复用 `packages/boot/main.ts` 的真实流程，不另造启动路径。

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { REPO_ROOT } from './closure.mjs'

export const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')

/** 跑一次 boot 命令；stdout 若为 JSON 则解析。 */
export function runBoot(root, args, options = {}) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 240_000,
    windowsHide: true,
  })
  const stdout = (result.stdout ?? '').trim()
  let json = null
  if (stdout.length > 0 && (stdout.startsWith('{') || stdout.startsWith('['))) {
    try {
      json = JSON.parse(stdout)
    } catch {
      json = null
    }
  }
  return { status: result.status, signal: result.signal, stdout, stderr: (result.stderr ?? '').trim(), json }
}

export function pack(root, dir, identity, options) {
  return runBoot(root, ['pack', dir, '--identity', identity], options)
}

export function seed(root, options) {
  return runBoot(root, ['seed'], options)
}

export function start(root, options) {
  return runBoot(root, ['start'], options)
}

export function status(root, options) {
  return runBoot(root, ['status'], options)
}

export function stop(root, options) {
  return runBoot(root, ['stop'], options)
}

export function verify(root, options) {
  return runBoot(root, ['verify'], options)
}

export function replay(root, options) {
  return runBoot(root, ['replay'], options)
}
