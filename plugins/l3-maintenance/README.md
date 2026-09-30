# l3-maintenance（L3 记忆维护）

L3（`memory-store` 长期条目）维护执行件：**L2 高价值项固化** + **低权重 / 超容量遗忘** + **视图 / 编辑**。
经反向调用读写 owner 服务，不读投影、不产世界写计划、不自取时钟（时间由调用帧 `env` 传入，同输入同输出）。

- 身份：`l3-maintenance`
- 能力类 / 方法：`l3-maintenance` → `solidify` / `forget` / `view` / `edit`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`l3-maintenance.json`）
- `needs`：`memory`（读 `list`，写 `append` / `delete` / `pin` / `edit`）、`short-memory`（读 `read` 取 L2 摘要）、
  `embedding`（`embed` 去重向量）
- 状态档：`recomputable`（不取时间 / 随机，同输入同输出）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## 四个方法

| 方法       | 做什么                                                                                                                                    | 写哪（经 owner 服务）                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `solidify` | 按 `workspaces` 作用域读 L2 摘要，取 `facts` / `decisions` 中 `weight ≥ 阈值`（或 `high_value` 强制）的项，与现有 L3 / 彼此余弦去重后追加 | `memory.append`（`meta.source=consolidate`） |
| `forget`   | 删低权重 / 超容量 L3（跳过 `pinned`）；`pinned` 之外按 weight / at / id 确定性淘汰；`dry_run` 只算不写                                    | `memory.delete`                              |
| `view`     | 只读：回 L3 一档（`at` / tags / source / workspace / `weight` / `pinned`）                                                                | 无（返回值）                                 |
| `edit`     | L3 删除 / 置顶 / 文本编辑                                                                                                                 | `memory.delete` / `pin` / `edit`             |

- **冲突消解（机械）**：同键多版本取确定序；语义矛盾机械不判。
- **确定性**：去重排序由 `(at 降序, 来源优先级, key 升序)` 完全决定；空集 / 空删除集**不产生写**。
- **参数**：`l3_capacity`（500）、`dedup_threshold`（0.9）、`weight_threshold`（0.7）、
  `candidate_threshold`（0.2）、`solidify_full_sources`（4）；覆盖值形态非法回 `bad_args`。
- **向量模型**：`embedding_model` 可选；缺省时不向 `embedding.embed` 带 `model`，由向量化门面按提供方
  `describe-models` 元数据选默认（本插件不硬编码模型名）。

## 运行

```sh
npm test    # 协议级 + 包形状测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
