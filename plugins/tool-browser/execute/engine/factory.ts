// 引擎工厂：按 schema impl 惰性加载生产实现；不可用即 browser_unsupported。
// 环境变量 `CHRONO_BROWSER_ENGINE_MODULE` 指向一个导出 `createEngine(config, handle)` 的模块时改用它——
// 这是引擎的外部扩展 / 测试注入点（模块住包外，不入世界）。

import { pathToFileURL } from 'node:url'
import { BrowserUnsupportedError } from './types.ts'
import { loadCdp } from './cdp.ts'
import { loadPlaywright } from './playwright.ts'
import type { CreationHandle } from '../creation.ts'
import type { BrowserEngine, EngineConfig, EngineLoader } from './types.ts'

/** 生产引擎加载器表；换引擎只改 schema impl，不改调用方。 */
export const DEFAULT_LOADERS: Record<string, EngineLoader> = {
  playwright: loadPlaywright,
  cdp: loadCdp,
}

/** 环境变量注入的外部引擎模块（扩展 / 测试用）。 */
export const ENGINE_MODULE_ENV = 'CHRONO_BROWSER_ENGINE_MODULE'

async function loadExternalEngine(
  modulePath: string,
  config: EngineConfig,
  handle: CreationHandle,
): Promise<BrowserEngine> {
  let module: { createEngine?: EngineLoader }
  try {
    module = (await import(pathToFileURL(modulePath).href)) as { createEngine?: EngineLoader }
  } catch (err) {
    throw new BrowserUnsupportedError(`cannot load engine module ${modulePath}: ${(err as Error).message}`)
  }
  if (typeof module.createEngine !== 'function') {
    throw new BrowserUnsupportedError(`engine module ${modulePath} does not export createEngine`)
  }
  return module.createEngine(config, handle)
}

/** 按配置造引擎；未知 impl / 加载失败 / 平台不可用一律 browser_unsupported。 */
export async function createEngine(
  config: EngineConfig,
  handle: CreationHandle,
  loaders: Record<string, EngineLoader> = DEFAULT_LOADERS,
): Promise<BrowserEngine> {
  const modulePath = process.env[ENGINE_MODULE_ENV]
  if (typeof modulePath === 'string' && modulePath.length > 0) {
    return loadExternalEngine(modulePath, config, handle)
  }
  const loader = loaders[config.impl]
  if (loader === undefined) {
    throw new BrowserUnsupportedError(`unknown engine impl ${config.impl}`)
  }
  return loader(config, handle)
}
