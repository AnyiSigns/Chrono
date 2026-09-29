# semantic（语义摘要原语）

语义摘要原语：提示词构建 + 模型输出围栏解析。经反向 `port.call model.chat` 出同结构摘要记录，
失败作数据（`{error:{code,message}}`）。被上层压缩门面 `compress` 经反向 `port.call` 消费；
自身不读投影、不写世界、不自取时钟。

- 身份：`semantic`
- 能力类 / 方法：`semantic` → `summarize`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`semantic.json`）
- `pins`：无（`"pins": {}`）；跨身份依赖走 `needs.model`（`model` → `model-protocol`，`one`）
- 状态档：`recomputable`（无本地持久状态；模型调用不重放、不缓存）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`semantic.summarize`
- 运行时零 npm 依赖

## 方法

| 方法        | 入参                                                 | 返回                                    | 行为                                                                                                             |
| ----------- | ---------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `summarize` | `{args: {model_config, session_slice}, existing_l1}` | `{summary}` 或 `{error:{code,message}}` | 组装系统提示词 + `{existing_l1, session_slice}`，经 `model.chat` 出回包；允许 ```json 围栏，解析成摘要记录原样回 |

- `model_config` 缺省 → `{error:{code:"model_config_required"}}`；模型无文本 → `semantic_empty`；
  输出既非 JSON 对象也非围栏内 JSON → `semantic_parse_failed`；模型服务原码透传（`model_call_failed` 兜底）。
- 只回**记录**：字段形态归一 / 截断由消费方经 `summarize` 提供方完成。
- 单次 `model.chat` 反向调用等待上限取 `model.chat` 声明超时（3600000ms），严格小于 `semantic.summarize`（3660000ms）。

## 入参（`args`）

```jsonc
{
  "args": {
    "model_config": {
      "base_url": "https://…",
      "model": "…",
      "quirks": { "impl": "protocol", "protocol": "openai-chat" },
    },
    "session_slice": [{ "role": "user", "content": "…" }],
  },
  "existing_l1": { "goal": "…", "facts": ["…"] },
}
```

## 结果

- 成功：`{summary}`——模型输出解析后的 JSON 对象。
- 失败（作数据，不炸本轮）：`{error:{code,message}}`。

## 边界

- 不做：字段形态归一 / 截断（归 `summarize` 提供方）/ 去重（归 `dedup` 提供方）/ L1 / L2 读写（归 `short-memory`）。
- 不写世界、不读投影、无命令面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test                        # 协议级 + 逻辑级测试（node --test；真实模型用例缺 .env 时优雅跳过）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
