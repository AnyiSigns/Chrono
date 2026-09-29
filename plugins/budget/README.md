# budget（预算建模与 token 校准提供方）

由模型档案与生效 policy 数值算出上下文预算标量与每来源配额上限，并维护每模型 token 校正系数：
`model`（窗 − 余量 → 预算标量与配额）/ `factor`（每模型系数）/ `observe`（以真实 usage 更新 EWMA）。
输出**不静态预留**：输入预算 = 窗 − 余量（余量是整体安全头寸），请求输出上限由消费方在请求期按剩余给
（`max_tokens = min(模型 max_output, 窗 − 已用输入)`）——输入越大输出越小，输入可尽量用满模型窗。
确定、同输入同输出、不取时间 / 随机。被上层 `context-window` 经反向 `port.call` 消费；自身无反向调用、
不读投影、无写通道。消息级配额分配（`allocate` / retention / order / pairing）留 `context-window`，不跨身份传
规范消息。

- 身份：`budget`
- 能力类 / 方法：`budget` → `model` / `factor` / `observe`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`
- `pins`：无（`"pins": {}`）
- `needs`：`token-estimate`（`one`；定价链上游声明）
- 状态档：`recomputable`（系数状态落 `CHRONO_PLUGIN_STATE/calibration.json`，可随时删）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`budget.model`
- 运行时零 npm 依赖

## 方法

| 方法      | 入参                       | 返回                          | 行为                                                                                |
| --------- | -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `model`   | `{config, policy}`         | `{budget, context_window, …}` | 窗 − 余量 → 预算标量（输出不静态预留，`max_output` 只作请求天花板）；按预算比例给每来源配额上限；缺档案标 `profile_missing` |
| `factor`  | `{model}`                  | `{factor}`                    | 当前生效的每模型校正系数（无则 1）                                                  |
| `observe` | `{model, estimate, usage}` | `{factor, usage}`             | 以真实用量按 EWMA 更新系数；返回更新后系数与该次解析出的用量形状                    |

- `model` 的 `policy`（`margin_ratio` / 默认窗 / 默认输出 / `quota` 比例）由消费方下传：**单一真源在消费方**；
  缺键回落本提供方默认值（与随包默认同值）。
- `observe` 的 `usage` 为厂商回包（`prompt_tokens`/`input_tokens`、`cached_tokens`/`cache_read_input_tokens`、
  `cache_creation_input_tokens`、`completion_tokens`/`output_tokens`…）；无 `prompt_tokens` 时 `usage` 回 `null`，
  仅推进 `last_estimate`。
- 系数 = 真实 `prompt_tokens` / 上一次估算的指数滑动平均（权重 0.2），上下限 `[0.5, 2]`；变化小于阈值不重写状态文件。

## 结果

- 成功：`{budget, …}` / `{factor}` / `{factor, usage}`。
- 失败：结构化 `bad_args`。

## 边界

- 不做：token 计数（归 `token-estimate`）/ 消息级配额分配与降级阶梯（归 `context-window`）。
- 不写世界、不读投影、无命令面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test    # 纯函数级 + 协议级测试（node --test）
```

## `.worldignore`

`test/` / `node_modules/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
