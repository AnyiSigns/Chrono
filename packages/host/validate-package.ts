// 宿主入世校验 dry-run：候选包源码树（内存文件表）→ 与 `seed` / `pack` 同一套机械校验，不写世界。
// 复用 `planPack` 是刻意的：validate 通过的包 = 入世通过的包，校验口径不可能漂移。
// 候选文件落临时目录（③，用后即删）——它不进世界、不参与重放，只是 `planPack` 的只读输入。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { planPack } from './assembly/index.ts'
import { decodeBase64Strict } from './common/cas.ts'
import { isSafePackageFilePath } from './common/paths-safe.ts'
import type { Json, World } from '../kernel/index.ts'

export interface ValidateError {
  code: string
  path: string
  message: string
}

export interface ValidatePackageReport {
  ok: boolean
  errors: ValidateError[]
  /** 候选树规范化后的 commit 哈希；`planPack` 未通过（任何原因）时为 null。 */
  result_hash: string | null
}

export type ValidatePackageOutcome =
  { accepted: true; report: ValidatePackageReport } | { accepted: false; message: string }

/** 候选文件值：文本字符串，或 `{ text }` / `{ base64 }` 显式形态（base64 只收规范编码）。 */
function decodeFile(value: Json): Buffer | null {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const hasText = typeof value['text'] === 'string'
  const hasBase64 = typeof value['base64'] === 'string'
  // 两形态同时出现是歧义输入：拒，不猜优先级
  if (hasText && hasBase64) return null
  if (hasText) return Buffer.from(value['text'] as string, 'utf8')
  if (hasBase64) return decodeBase64Strict(value['base64'] as string)
  return null
}

/** 校验原因 → 结构化错误：`missing_entry:<path>` / `missing_args_schema:<path>` 带出路径，其余 path 为空。 */
function errorOf(reason: string): ValidateError {
  const separator = reason.indexOf(':')
  const code = separator === -1 ? reason : reason.slice(0, separator)
  const detail = separator === -1 ? '' : reason.slice(separator + 1)
  const path =
    code === 'missing_entry' || code === 'missing_args_schema' ? detail.split(':')[0] : ''
  return { code, path, message: reason }
}

/**
 * 对一份候选包源码树跑入世机械校验，返回错误列表与规范化树哈希；不写世界。
 * `files` 形状非法（非对象 / 路径逃逸 / 值形态不符）→ `accepted:false`（调用方按 `bad_directive` 收口）。
 * `blobsDir` 仅供读取旧世代的 pointer 声明；候选包字节一律不落 CAS（dry-run）。
 * `configRoot` 是仓库根：受保护 pin 名单从它的 `chrono.config.json` 读（候选目录不是仓库根）。
 */
export function validatePackage(
  world: World,
  runtimeDir: string,
  files: Json,
  blobsDir?: string,
  configRoot?: string,
): ValidatePackageOutcome {
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return { accepted: false, message: 'validate_package expects { files }' }
  }
  const entries: Array<[string, Buffer]> = []
  for (const [path, value] of Object.entries(files)) {
    if (!isSafePackageFilePath(path)) return { accepted: false, message: `unsafe path: ${path}` }
    const bytes = decodeFile(value)
    if (bytes === null) return { accepted: false, message: `bad file: ${path}` }
    entries.push([path, bytes])
  }

  mkdirSync(runtimeDir, { recursive: true })
  const dir = mkdtempSync(join(runtimeDir, 'validate-'))
  try {
    for (const [path, bytes] of entries) {
      const abs = join(dir, ...path.split('/'))
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, bytes)
    }
    const plan = planPack(world, dir, undefined, blobsDir, configRoot)
    if (!plan.ok) {
      return {
        accepted: true,
        report: {
          ok: false,
          errors: plan.reasons.map(errorOf),
          result_hash: null,
        },
      }
    }
    return {
      accepted: true,
      report: { ok: true, errors: [], result_hash: plan.plan.commitHash },
    }
  } catch (err) {
    return {
      accepted: true,
      report: {
        ok: false,
        errors: [
          {
            code: 'internal',
            path: '',
            message: err instanceof Error ? err.message : String(err),
          },
        ],
        result_hash: null,
      },
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
