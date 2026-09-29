# l2-maintenance（L2 记忆维护）

L2（`short-memory` 的工作区摘要）维护执行件：**L1→L2 分组合并去重** + **超容量裁剪** + **视图 / 编辑**。
经反向调用读写 owner 服务，不读投影、不产世界写计划、不自取时钟（时间由调用帧 `env` 传入，同输入同输出）。

- 身份：`l2-maintenance`
- 能力类 / 方法：`l2-maintenance` → `merge` / `trim` / `view` / `edit`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`l2-maintenance.json`）
- `needs`：`short-memory`（读 `read`，写 `apply`）、`session`（读 `read`，会话 → 工作区归属）、
  `embedding`（`embed` 去重向量）、`compress`（需要摘要时 `summarize`，`persist:false`）
- 状态档：`recomputable`（不取时间 / 随机，同输入同输出）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## 四个方法

| 方法    | 做什么                                                                                                                    | 写哪（经 owner 服务）                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `merge` | L1 按工作区归属分组，逐字段向量去重后合并进 L2（`sources[]` 追加来源会话、最新在前）；需要摘要时 eff `compress.summarize` | `short-memory.apply`（`set_workspaces`） |
| `trim`  | L2 超容量（`l2_capacity`）从最旧一端裁；`dry_run` 时只算不写、回 `l2_over_capacity` 候选                                  | `short-memory.apply`（`set_workspaces`） |
| `view`  | 只读：回 L2 一档（`at` / `summary` / `sources`）                                                                          | 无（返回值）                             |
| `edit`  | L1 / L2 删除 / 摘要编辑（置顶不适用），经反向调用写 owner 服务                                                            | `short-memory.apply`                     |

- **确定性**：去重排序由 `(at 降序, 来源优先级, key 升序)` 完全决定；空集 / 空变更集**不产生写**。
- **失败不半写**：`compress` / `embedding` 不可用时回结构化错误（先读后算、确认成功才写）。
- **参数**：`dedup_threshold`（缺省 0.9）、`l2_capacity`（缺省 200）；形态非法回 `bad_args`。

## 运行

```sh
npm test    # 协议级 + 包形状 + 纯函数测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
