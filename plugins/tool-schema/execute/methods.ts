// 能力类 `tool-schema` 的方法表：normalize-decl / validate-args / normalize-caps。
// 纯函数面：schema 与 caps 随 args 传入（服务不读投影、无反向调用、无写通道），重逻辑全部住本提供方。
// - normalize-decl：严格校验或宽松净化声明的 argsSchema；- validate-args：按同一方言校验模型 args；
// - normalize-caps：归一 caps 对象形并校验 fs / net / 数值上限。

import { BadArgsError, isRecord } from 'plugin-sdk'
import {
  normalizeCaps,
  sanitizeArgsSchema,
  validateArgs,
  validateArgsSchema,
} from './schema-validate.ts'
import type { Handler, HandlerResult, Json } from 'plugin-sdk'

/** normalize-decl：lenient 剥白名单外关键词；严格校验（白名单外拒）。 */
function normalizeDecl(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const schema = args['schema'] ?? null
  if (args['lenient'] === true) {
    return { ok: true, message: '', schema: sanitizeArgsSchema(schema ?? { type: 'object' }) }
  }
  const result = validateArgsSchema(schema)
  return { ok: result.ok, message: result.message, schema: result.ok ? schema : null }
}

/** validate-args：用白名单方言校验 value。 */
function validateArgsOf(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const result = validateArgs(args['schema'], args['value'])
  return { ok: result.ok, message: result.message }
}

/** normalize-caps：归一 caps；lenient 缺项按 none、非对象回落缺省。 */
function normalizeCapsOf(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const result = normalizeCaps(args['caps'], args['lenient'] === true)
  return { ok: result.ok, message: result.message, caps: result.caps as Json }
}

/** 构造方法表（纯函数，无依赖注入）。 */
export function createHandlers(): Record<string, Handler> {
  return {
    'normalize-decl': (args: Json): HandlerResult => ({ value: normalizeDecl(args), events: [] }),
    'validate-args': (args: Json): HandlerResult => ({ value: validateArgsOf(args), events: [] }),
    'normalize-caps': (args: Json): HandlerResult => ({ value: normalizeCapsOf(args), events: [] }),
  }
}
