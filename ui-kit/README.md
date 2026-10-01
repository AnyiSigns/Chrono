# @chrono/ui-kit

slot 插件共用的第一方 UI 套件，是各插件重复实现的唯一来源：

- `Icon` / `IconButton`：图标 sprite 引用与图标按钮外壳（React 组件）。
- `createMessages(uiText)`：文案表解析 / 取用 / 拉取，按插件注入本地 `UI_TEXT` 兜底。
- `createStore(initial)`：React-free 的 `{getSnapshot, subscribe, commit}` store 原语。
- `client.read` 读回助手：包内相对 `.js` 路径防护与文件读取（服务端，`node:fs`）。

## 为什么打包产物里有 `src/*.js`

`exports` 同时给出 `node` 与 `browser` 条件：Node 运行时禁止对 `node_modules` 内的
文件做 TypeScript 类型擦除（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），故
服务端 / 单测经 `node` 条件加载 `src/*.js`（`tools/pack-ui-kit.mjs` 预编译）；
客户端半边由 esbuild 打包，经 `browser` 条件直接用 `src/*.ts(x)` 源码。
两者语义一致，`.ts` 始终是唯一真源。
