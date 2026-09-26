// CLI 薄壳（genesis 常量）：解析入口参数后交给派发表；非保留命令连宿主按声明调用。
// 只做参数解析与转发，不认识任何业务语义。

import { parseEntryArgv, resolveRoot } from '../host/index.ts'
import { dispatchPluginCommand, handlers, helpText } from './commands.ts'

async function main(): Promise<void> {
  const options = parseEntryArgv(process.argv.slice(2))
  const root = resolveRoot(options.root)
  const [command, ...args] = options.rest

  if (command === undefined) {
    process.stdout.write(`${helpText()}\n`)
    return
  }
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined
  if (handler !== undefined) {
    await handler({ root, args, options })
    return
  }
  await dispatchPluginCommand(root, command, args)
}

try {
  await main()
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exitCode = 1
}
