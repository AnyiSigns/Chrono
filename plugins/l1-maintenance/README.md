# l1-maintenance（L1 记忆维护）

L1（`short-memory` 的会话摘要）维护执行件：**TTL 24h 过期清理** + **过期候选** + **L1 视图**。
经反向调用读写 owner 服务，不读投影、不产世界写计划、不自取时钟（时间由调用帧 `env` 传入，同输入同输出）。

- 身份：`l1-maintenance`
- 能力类 / 方法：`l1-maintenance` → `sweep` / `candidates` / `view`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`l1-maintenance.json`）
- `needs`：`short-memory`（读 `read`，写 `apply`）、`session`（读 `read`，会话归属，对齐原维护服务的 owner 读取面）
- 状态档：`recomputable`（不取时间 / 随机，同输入同输出）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## 三个方法

| 方法         | 做什么                                                          | 写哪（经 owner 服务）                  |
| ------------ | --------------------------------------------------------------- | -------------------------------------- |
| `sweep`      | 选到期 L1（`expires_at` 优先，否则 `at + TTL`）并删除           | `short-memory.apply`（`del_sessions`） |
| `candidates` | 只读：回过期 L1 候选列表，不删、不写                            | 无（返回值）                           |
| `view`       | 只读：回 L1 一档，含 `at` / `expires_at` / 剩余 TTL / `summary` | 无（返回值）                           |

- **确定性**：会话按 id 升序遍历；空删除集**不产生写**。
- **参数**：`l1_ttl_ms`（缺省 86400000）由调用方随 args 传入；形态非法回 `bad_args`。

## 运行

```sh
npm test    # 协议级 + 包形状 + 纯函数测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
