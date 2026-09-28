// 契约源入口：运行子集 + 根测试期断言器的再导出。
// 运行期代码由 tools/generate.mjs 从 src/runtime.ts 派生进各消费插件，不 import 本包。

export * from './runtime.ts'
