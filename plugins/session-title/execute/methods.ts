// 能力类 `session-title` 的方法表：generate。
// 只生成标题并上提会话服务的写计划：不读投影、不落账、不自取时钟、不内置任何模型名。
// 模型连接与所选模型由调用方入口 term 读出随 args 传入；模型失败 / 超时 / 空一律回落，绝不报错阻塞主回合。

import { resolveConfig } from './config.ts'
import { log } from './frames.ts'
import { asString, errorValue, externOnly, hasDirectives, isRecord } from './plan.ts'
import { resolveTitle } from './title.ts'
import { BadArgsError } from './types.ts'
import type { TitleConfig } from './config.ts'
import type { ModelBackend, SessionBackend } from './port-link.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface GenerateDeps {
  config: TitleConfig
  model?: ModelBackend
  session?: SessionBackend
}

interface GenerateArgs {
  conversation: string
  firstMessage: string
  titleDefault: string
  modelConfig: Rec | null
  session: Rec | null
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
    conversation,
    firstMessage,
    titleDefault: asString(args['title_default']) ?? DEFAULT_TITLE_DEFAULT,
    modelConfig: explicitConfig ?? buildModelConfig(args, params),
    session: isRecord(args['session']) ? args['session'] : null,
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
    log(`model.complete failed: ${(err as Error).message}`)
    return null
  }
}

/** 调会话服务写入标题，原样上提其写计划；无计划 / 调用失败时回一条 extern 失败值。 */
async function writeTitle(parsed: GenerateArgs, title: string, config: TitleConfig, deps: GenerateDeps): Promise<Json> {
  if (deps.session === undefined) {
    return externOnly(errorValue('session_unavailable', 'no session backend wired'))
  }
  const setArgs: Rec = { conversation: parsed.conversation, title }
  if (parsed.session !== null) setArgs['session'] = parsed.session
  try {
    const value = await deps.session.setTitle(setArgs, config.timeoutMs)
    if (hasDirectives(value)) return value
    return externOnly(errorValue('set_title_failed', 'session.set_title returned no plan'))
  } catch (err) {
    log(`session.set_title failed: ${(err as Error).message}`)
    return externOnly(errorValue('set_title_failed', (err as Error).message))
  }
}

async function generate(args: Json, _env: CallEnv, deps: GenerateDeps): Promise<Json> {
  const parsed = parseArgs(args)
  const config = resolveConfig(deps.config, parsed.overrides)
  const modelText = await callModel(parsed, config, deps)
  const title = resolveTitle(modelText, parsed.firstMessage, config.maxChars, parsed.titleDefault)
  return writeTitle(parsed, title, config, deps)
}

/** 构造方法表（依赖注入：模型与会话后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: GenerateDeps): Record<string, Handler> {
  return {
    generate: (args: Json, env: CallEnv): Promise<Json> => generate(args, env, deps),
  }
}
