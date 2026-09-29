// 能力类 `secrets-backend` 的三个方法：read（按名读一条进程环境明文）、list（恒空表）与
// kinds（自述支持的 auth_ref.kind 集，供 `secrets` 按 kind 定位后端）。
// 只读本服务进程环境；auth_ref 形态与 kind 词表归上层 `secrets`。
// 明文只在返回值里，绝不进日志 / stderr / 缓存。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { EnvSecretError } from './types.ts'
import type { Handler, Json } from 'plugin-sdk'

/** 本后端支持的 auth_ref.kind（唯一：本服务进程环境）。 */
export const ENV_KINDS: readonly string[] = ['env']

export interface EnvSecretsDeps {
  /** 本服务进程环境（`env` kind 的取值面）。 */
  env: Record<string, string | undefined>
}

/** 解析 read 的 args：取引用名；缺失 / 非法抛 bad_args。 */
function parseName(args: Json): string {
  const name = isRecord(args) ? args['name'] : undefined
  if (typeof name !== 'string' || name.length === 0 || name.includes('\u0000')) {
    throw new BadArgsError('name must be a non-empty string')
  }
  return name
}

/** 读取一条引用名对应的明文（仅存调用方内存）。 */
function readSecret(args: Json, deps: EnvSecretsDeps): Json {
  const name = parseName(args)
  const value = deps.env[name]
  if (value === undefined)
    throw new EnvSecretError('secret_missing', `env secret not found: ${name}`)
  return value
}

/**
 * 进程环境无稳定枚举接口，且列出变量名会泄漏宿主环境，故恒回空表——
 * 不改变上层 `secrets.list` 的清单语义（清单只来自可枚举后端）。
 */
function listSecrets(): Json {
  return []
}

/** 自述本后端支持的 kind（`secrets` 据此在成员间定位）。 */
function kinds(): Json {
  return [...ENV_KINDS]
}

/** 构造方法表（依赖注入：进程环境由入口提供，便于测试与确定性）。 */
export function createHandlers(deps: EnvSecretsDeps): Record<string, Handler> {
  return {
    read: (args) => ({ value: readSecret(args, deps), events: [] }),
    list: () => ({ value: listSecrets(), events: [] }),
    kinds: () => ({ value: kinds(), events: [] }),
  }
}
