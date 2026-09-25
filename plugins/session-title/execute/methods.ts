// 能力类 `session-title` 的方法表：generate。
// 只生成**标题值**：不读投影、不落账、不自取时钟、不内置任何模型名、不写世界本体。
// 模型连接与所选模型由调用方入口 term 读出随 args 传入；模型失败 / 超时 / 空一律回落，绝不报错阻塞主回合。
// 标题落盘归调用方（chat）：把标题并入传给 interpret 的 session body，由 session.commit 一次性落盘——
// 避免本插件另发一条整份 session 写与 commit 同回合竞争（lost update）。

import { resolveConfig } from './config.ts'
import { log } from './frames.ts'
import { asString, isRecord } from './plan.ts'
import { resolveTitle } from './title.ts'
import { BackendError, BadArgsError } from './types.ts'
import type { TitleConfig } from './config.ts'
import type { ModelBackend } from './port-link.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface GenerateDeps {
  config: TitleConfig
  model?: ModelBackend
}

interface GenerateArgs {
  firstMessage: string
  titleDefault: string
  modelConfig: Rec | null
  overrides: Rec
}

/** 会话缺省标题（与新建会话一致）；调用方给了 `title_default` 时以调用方为准。 */
const DEFAULT_TITLE_DEFAULT = '新对话'

/** 由 args 里的 vendor / model / params 组装模型连接实例；全缺则视为未配置。 */
function buildModelConfig(args: Rec, params: Rec | null): Rec | null {
  const config: Rec = {}
  const vendor = asString(args['vendor'])
  const model = asString(args['model'])
  if (vendor !== null) config['vendor'] = vendor
  if (model !== null) config['model'] = model
  if (params !== null) config['params'] = params
  return Object.keys(config).length > 0 ? config : null
}

/** 解析 args（bag）为生成上下文；缺 `conversation` / `first_message` 抛 `BadArgsError`。 */
function parseArgs(args: Json): GenerateArgs {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const conversation = asString(args['conversation'])
  if (conversation === null) throw new BadArgsError('conversation required')
  const firstMessage = asString(args['first_message'])
  if (firstMessage === null) throw new BadArgsError('first_message required')
  const params = isRecord(args['params']) ? args['params'] : null
  const explicitConfig = isRecord(args['config']) ? args['config'] : null
  return {
    firstMessage,
    titleDefault: asString(args['title_default']) ?? DEFAULT_TITLE_DEFAULT,
    modelConfig: explicitConfig ?? buildModelConfig(args, params),
    overrides: args,
  }
}

/** 非流式单次补全：失败 / 超时 / 空一律回 null，由调用方走兜底。 */
async function callModel(parsed: GenerateArgs, config: TitleConfig, deps: GenerateDeps): Promise<string | null> {
  if (deps.model === undefined || parsed.modelConfig === null) return null
  const messages: Json[] = [
    { role: 'system', content: config.prompt },
    { role: 'user', content: parsed.firstMessage },
  ]
  try {
    const result = await deps.model.complete(parsed.modelConfig, messages, config.maxTokens, config.timeoutMs)
    return asString(result['text'])
  } catch (err) {
    // 带上结构化码：`model.complete reported failure` 本身不含原因，码（model_auth_failed / model_network_error …）才是可诊断信息。
    const code = err instanceof BackendError ? `${err.code}: ` : ''
    log(`model.complete failed: ${code}${(err as Error).message}`)
    return null
  }
}

/** 生成标题值：模型失败 / 超时 / 空 → 确定性兜底；结果形状 `{ok:true, title}`。 */
async function generate(args: Json, _env: CallEnv, deps: GenerateDeps): Promise<Json> {
  const parsed = parseArgs(args)
  const config = resolveConfig(deps.config, parsed.overrides)
  const modelText = await callModel(parsed, config, deps)
  const title = resolveTitle(modelText, parsed.firstMessage, config.maxChars, parsed.titleDefault)
  return { ok: true, title }
}

/** 构造方法表（依赖注入：模型后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: GenerateDeps): Record<string, Handler> {
  return {
    generate: (args: Json, env: CallEnv): Promise<Json> => generate(args, env, deps),
  }
}
