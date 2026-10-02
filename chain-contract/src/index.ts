// 契约源入口：运行子集 + 根测试期断言器的再导出。
// 消费插件运行期裸导入本包；由宿主准备阶段链接进物化树 `node_modules/chain-contract`。

export * from './runtime.ts'
