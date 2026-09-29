// 方言提供方（`msg-dialect`）的反向调用客户端：把每次 `port.call` 归一成类型化方法。
// 失败作数据 -> 结构化 `model_unsupported`（提供方不可用 / 协议不支持），由调用方作数据回灌。

import { ModelError } from './errors.ts'
import { isRecord } from './plan.ts'
import type { ModelOutput } from './adapters.ts'
import type { Json, PortCaller, Rec } from 'plugin-sdk'

/** 归一后的 quirks（本插件只读流式所需的少量字段；其余字段原样透传给 build）。 */
export interface DialectQuirks {
  impl: 'protocol' | 'sdk'
  protocol: string
  sdk_package: string | null
  reasoning_response_field: string | null
  [key: string]: Json | undefined
}

export interface BuiltRequest {
  kind: 'http' | 'sdk'
  protocol: string
  url?: string
  headers?: Rec
  body?: Rec
  params?: Rec
}

export interface CapabilityInput {
  provider?: string | null
  protocol?: string | null
  impl?: string | null
  profile?: Json
}

export class DialectClient {
  private readonly caller: PortCaller

  constructor(caller: PortCaller) {
    this.caller = caller
  }

  private async invoke(method: string, args: Rec): Promise<Json> {
    const outcome = await this.caller.call('msg-dialect', method, args)
    if (!outcome.ok)
      throw new ModelError('model_unsupported', `msg-dialect.${method} failed: ${outcome.code}`)
    return outcome.value
  }

  async normalizeQuirks(
    quirks: Json | undefined,
    protocolOverride: string | null,
  ): Promise<DialectQuirks> {
    const value = await this.invoke('normalize-quirks', {
      quirks: quirks ?? null,
      protocol_override: protocolOverride,
    })
    if (!isRecord(value) || !isRecord(value['quirks'])) {
      throw new ModelError('model_unsupported', 'msg-dialect.normalize-quirks returned no quirks')
    }
    return value['quirks'] as DialectQuirks
  }

  async reasoningCapability(input: CapabilityInput): Promise<Rec> {
    const args: Rec = {}
    if (input.provider !== undefined && input.provider !== null) args['provider'] = input.provider
    if (input.protocol !== undefined && input.protocol !== null) args['protocol'] = input.protocol
    if (input.impl !== undefined && input.impl !== null) args['impl'] = input.impl
    if (input.profile !== undefined) args['profile'] = input.profile
    const value = await this.invoke('reasoning-capability', args)
    if (!isRecord(value) || !isRecord(value['capability'])) {
      throw new ModelError(
        'model_unsupported',
        'msg-dialect.reasoning-capability returned no capability',
      )
    }
    return value['capability'] as Rec
  }

  async inlineAssets(messages: Json[], protocol: string): Promise<Json[]> {
    const value = await this.invoke('inline-assets', { messages, protocol })
    if (!isRecord(value) || !Array.isArray(value['messages'])) {
      throw new ModelError('model_unsupported', 'msg-dialect.inline-assets returned no messages')
    }
    return value['messages'] as Json[]
  }

  async applyAuth(
    url: string,
    quirks: Json,
    secret: string | null,
  ): Promise<{ url: string; headers: Rec }> {
    const value = await this.invoke('apply-auth', { url, quirks, secret })
    if (!isRecord(value) || typeof value['url'] !== 'string' || !isRecord(value['headers'])) {
      throw new ModelError('model_unsupported', 'msg-dialect.apply-auth returned no auth')
    }
    return { url: value['url'] as string, headers: value['headers'] as Rec }
  }

  async build(args: Rec): Promise<BuiltRequest> {
    const value = await this.invoke('build', args)
    if (!isRecord(value) || (value['kind'] !== 'http' && value['kind'] !== 'sdk')) {
      throw new ModelError('model_unsupported', 'msg-dialect.build returned no request')
    }
    return value as unknown as BuiltRequest
  }

  async parseFull(args: Rec): Promise<ModelOutput> {
    const value = await this.invoke('parse-full', args)
    if (!isRecord(value))
      throw new ModelError('model_unsupported', 'msg-dialect.parse-full returned no output')
    return value as unknown as ModelOutput
  }
}
