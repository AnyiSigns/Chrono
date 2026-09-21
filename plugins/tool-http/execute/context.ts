// 一次工具调用的上下文：运行配置、调用方随 bag 传入的 caps / tier / 执行根 / 一次性 grant，
// 以及可注入的网络后端。服务不读投影、不取时间、不写世界。

import type { HttpBackend } from './backend.ts'
import type { Config } from './config.ts'
import type { Json, Rec } from './types.ts'

export interface ToolContext {
  config: Config
  caps: Rec | undefined
  tier: string | undefined
  workspaceRoot: string | undefined
  sandboxTiers: Json | undefined
  grant: Json | undefined
  backend: HttpBackend
}
