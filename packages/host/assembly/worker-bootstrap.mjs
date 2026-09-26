// worker 形态的宿主侧引导：载入插件声明的同语言入口模块，把 worker 消息接到服务派发器。
// 由 assembly/service-host.ts 经 `new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), { workerData })`
// 启动；`workerData = { entry, env }`。本文件是框架代码，不属于任何插件、不入世界。

import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const data = workerData ?? {}
const module = await import(pathToFileURL(data.entry).href)
const factory = module.createService ?? module.default?.createService ?? module.default
if (typeof factory !== 'function') {
  throw new Error('service_entry_missing_createService')
}

const instance = factory({
  emit: (message) => parentPort.postMessage(message),
  env: data.env ?? {},
})

parentPort.on('message', (message) => {
  instance.receive(message)
})
