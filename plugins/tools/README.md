# tools（工具门面）

工具能力的**薄门面**：保留原 `tools` 契约与公开方法 `list` / `dispatch`，把算法委派给下层提供方——
目录装配归 `tool-registry`，整批派发归 `tool-dispatch`，schema / caps 校验归 `tool-schema`。
既有消费方（`loop-policy` 的 `tool.*` 图数据端口）**零改动**。

- 身份 / 能力类：`tools`，`methods: {tools:["list","dispatch"]}`；无命令。
- `pins`：只保留保留身份 `host`（`"pins": {"host": "host"}`）。
- `needs`：`tool-registry`（`one`）与 `tool-dispatch`（`one`）——门面只持有这两个直接提供方，
  工具提供者类与 `guard` 等由下游各自 `needs` 引用（各插件自述为准）。
- 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 方法（门面语义）

`list(bag)` 与 `dispatch(bag)` 的数据形状与拆分前**逐字段一致**；门面不做任何本地算法，只把 `bag`
原样反向委派：

| 方法       | 委派目标                 | 结果形状                                         |
| ---------- | ------------------------ | ------------------------------------------------ |
| `list`     | `tool-registry.list`     | `{tools:[声明], rejected:[{name,code,message}]}` |
| `dispatch` | `tool-dispatch.dispatch` | `{results:[{call_id, ok, result                  | error}]}`（保序） |

- 门面对 `bag` 形态只做透传；下游失败按其**原错误码**透传（如 `bad_args` / `unresolved_cap`）。
- `dispatch` 声明 `concurrent_methods`：两次派发在途互不阻塞（下游 `tool-dispatch.dispatch` 同声明）。

## 下游链

```
tool-schema → tool-registry / tool-dispatch → tools → loop-policy
```

- `tool-schema`：argsSchema 白名单校验 / 净化与 caps 形状（纯函数）。
- `tool-registry`：工具目录装配（describe 并集 + 绑定表 + 外部 MCP 工具；四要素 / 去重 / 文案 / 注入参数）。
- `tool-dispatch`：批级 guard 兜底 / 最严批级 / 有界并发池 / 结果缓存 / 事件与提供者扇出。

各提供方的入参、错误码与私有参数见其自身自述与 `schema/`。

## 服务纪律

服务不读投影（目录 / 执行根由调用方随 bag 传入）、不取时间 / 随机、同输入同输出；
不落账、无写通道；跨插件只走反向帧 `port.call`。

## 运行

```sh
npm test                                  # 协议级 + 逻辑级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（pack/seed → 投影 → 直连协议冒烟 → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` /
`execute/`）随源码入世。
