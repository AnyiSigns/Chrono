// 场景装配：模型桩 + 临时根世界 + 客户端 + 记录器 + 模型配置写入。
// 这是测试文件唯一的启动入口；dispose 幂等，桩与世界都随场景回收。

import { startModelStub } from './model-stub.mjs'
import { bootWorld } from './world.mjs'
import { createRecorder } from './recorder.mjs'

/** 写入自定义厂商连接实例：base_url 指向模型桩，协议走 openai-chat。 */
export async function configureModel(client, baseUrl, overrides = {}) {
  const model = overrides.model ?? 'stub-model'
  const body = {
    version: 1,
    vendor: 'custom',
    model,
    params: { temperature: 0, max_tokens: 256 },
    permission: overrides.permission ?? 'auto',
    ui: {},
    providers: {
      custom: {
        name: 'custom',
        protocol: 'openai-chat',
        base_url: baseUrl,
        models: {
          [model]: {
            name: model,
            context_window: overrides.contextWindow ?? 100_000,
            max_output: 256,
          },
        },
      },
    },
  }
  const result = await client.command('config.write', { body })
  return result
}

/**
 * 起一个完整场景：模型桩 → 临时根世界 → 客户端 → 记录器 → 写模型配置。
 * 桩在启动世界前就绪，`base_url` 固定；任一环节失败即回收已起的部分再抛。
 */
export async function bootScenario(options = {}) {
  const stub = startModelStub({ responder: options.responder ?? null, defaultText: options.defaultText })
  await stub.ready
  let world = null
  let client = null
  try {
    world = await bootWorld(options)
    client = await world.connect()
    const recorder = createRecorder(client)
    await configureModel(client, stub.url, options.config)
    let disposed = false
    return {
      stub,
      world,
      client,
      recorder,
      async dispose() {
        if (disposed) return
        disposed = true
        try {
          client.close()
        } catch {
          // 连接已断
        }
        await stub.close()
        await world.dispose()
      },
    }
  } catch (err) {
    if (client !== null) client.close()
    await stub.close()
    if (world !== null) await world.dispose()
    throw err
  }
}
