// 能力类 `msg-dialect` 的方法表：normalize-quirks / reasoning-capability / encode-tools / apply-auth /
// build / parse-full / inline-assets。
// 纯方言编解码：不读投影、不写世界、不自取时钟。唯一反向调用是 `host.asset.get`（资产内联取字节）。
// 逐段流式 SSE 解析不在此（跨插件 port.call 不能传流式回调），留消费方 `model-protocol`。

import { BadArgsError, isRecord } from 'plugin-sdk'
import {
  applyAuthToUrl,
  buildRequest,
  encodeTools,
  normalizeQuirks,
  parseFull,
  resolveReasoningCapability,
} from './dialect.ts'
import type { BuildArgs, BuiltRequestOut, ParseFullArgs } from './dialect.ts'
import { capabilityToJson } from './reasoning.ts'
import { createHostFetcher, resolveAssets } from './assets.ts'
import type { Quirks } from './quirks.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, Rec } from 'plugin-sdk'

export interface MsgDialectDeps {
  host: PortCaller
}

function recordOf(args: Json | null, field: string): Rec {
  if (!isRecord(args)) throw new BadArgsError(`${field} required`)
  return args
}

function stringArg(record: Rec, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) throw new BadArgsError(`${field} required`)
  return value
}

/** 归一 quirks；未给 raw quirks 时按协议默认。 */
function quirksArg(record: Rec): Quirks {
  const raw = record['quirks']
  const override = record['protocol_override']
  return normalizeQuirks(raw, typeof override === 'string' ? override : null)
}

function buildArgs(record: Rec): BuildArgs {
  const messages = record['messages']
  if (!Array.isArray(messages)) throw new BadArgsError('messages must be an array')
  const args: BuildArgs = {
    quirks: quirksArg(record),
    provider: stringArg(record, 'provider'),
    model: stringArg(record, 'model'),
    messages,
  }
  if (typeof record['base_url'] === 'string') args.base_url = record['base_url']
  if (isRecord(record['params'])) args.params = record['params']
  if (typeof record['secret'] === 'string') args.secret = record['secret']
  else if (record['secret'] === null) args.secret = null
  if (typeof record['stream'] === 'boolean') args.stream = record['stream']
  if (record['tools'] !== undefined) args.tools = record['tools']
  if (record['tool_choice'] !== undefined) args.tool_choice = record['tool_choice']
  if (isRecord(record['cache'])) args.cache = record['cache'] as BuildArgs['cache']
  if (record['capability_profile'] !== undefined)
    args.capability_profile = record['capability_profile']
  return args
}

/** 构造方法表（反向调用链 host 由入口按连接提供，供资产内联取字节）。 */
export function createHandlers(deps: MsgDialectDeps): Record<string, Handler> {
  const fetchAsset = createHostFetcher(deps.host)
  return {
    'normalize-quirks': (args: Json): HandlerResult => {
      const record = isRecord(args) ? args : {}
      const override = record['protocol_override']
      return { value: { quirks: quirksArg(record) as unknown as Json }, events: [] }
    },
    'reasoning-capability': (args: Json): HandlerResult => {
      const record = isRecord(args) ? args : {}
      const capability = resolveReasoningCapability({
        provider: typeof record['provider'] === 'string' ? record['provider'] : null,
        protocol: typeof record['protocol'] === 'string' ? record['protocol'] : null,
        impl: typeof record['impl'] === 'string' ? record['impl'] : null,
        profile: record['profile'],
      })
      return { value: { capability: capabilityToJson(capability) as Json }, events: [] }
    },
    'encode-tools': (args: Json): HandlerResult => {
      const record = recordOf(args, 'args')
      return {
        value: { tools: encodeTools(record['tools'], stringArg(record, 'protocol')) as Json },
        events: [],
      }
    },
    'apply-auth': (args: Json): HandlerResult => {
      const record = recordOf(args, 'args')
      const url = stringArg(record, 'url')
      const secret = typeof record['secret'] === 'string' ? record['secret'] : null
      const result = applyAuthToUrl(url, quirksArg(record), secret)
      return { value: { url: result.url, headers: result.headers as Json }, events: [] }
    },
    build: (args: Json): HandlerResult => {
      const record = recordOf(args, 'args')
      const built: BuiltRequestOut = buildRequest(buildArgs(record))
      return { value: built as unknown as Json, events: [] }
    },
    'parse-full': (args: Json): HandlerResult => {
      const record = recordOf(args, 'args')
      const parseArgs: ParseFullArgs = {
        quirks: quirksArg(record),
        provider: stringArg(record, 'provider'),
        model: stringArg(record, 'model'),
        json: record['json'] ?? null,
      }
      return { value: parseFull(parseArgs) as unknown as Json, events: [] }
    },
    'inline-assets': async (args: Json): Promise<HandlerResult> => {
      const record = recordOf(args, 'args')
      const messages = record['messages']
      if (!Array.isArray(messages)) throw new BadArgsError('messages must be an array')
      const protocol = stringArg(record, 'protocol')
      const resolved = await resolveAssets(messages, protocol, fetchAsset)
      return { value: { messages: resolved }, events: [] }
    },
  }
}
