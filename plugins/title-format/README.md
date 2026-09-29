# title-format（标题后处理原语）

标题后处理原语（纯函数）：`clean`（模型输出清理）/ `fallback`（首条消息兜底）/ `resolve`（兜底顺序）。
被上层标题服务 `session-title` 经反向 `port.call` 消费；自身无反向调用、不读投影、不写世界。

- 身份：`title-format`
- 能力类 / 方法：`title-format` → `clean` / `fallback` / `resolve`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`title-format.json`）
- `pins`：无（`"pins": {}`；无宿主 / 跨身份依赖）
- 状态档：`recomputable`（无本地持久状态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`title-format.resolve`
- 运行时零 npm 依赖

## 方法

| 方法       | 入参                                                    | 返回      | 行为                                                                                             |
| ---------- | ------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `clean`    | `{text, max_chars}`                                     | `{title}` | 取首个非空行 → 去首尾空白 / 引号 / 换行 → 去结尾标点 → 按 **Unicode 码点**硬截断到 ≤ `max_chars` |
| `fallback` | `{first_message, max_chars}`                            | `{title}` | 首条用户消息折叠空白并去首尾后，按码点取前 `max_chars` 字                                        |
| `resolve`  | `{model_text, first_message, max_chars, title_default}` | `{title}` | 兜底顺序：模型清理结果 → 首条消息前 N 字 → 调用方缺省标题                                        |

- `model_text` 为 `null`（模型失败 / 超时 / 未配置）时跳过清理，直接走兜底。
- `max_chars` 为 **Unicode 码点**上限：CJK 每字算 1，不劈代理对。
- `resolve` 的 `title_default` 由调用方保证非空；本插件不内置任何标题文案。
- 纯函数：不取时间 / 随机，同输入同输出。

## 入参（`args`）

```jsonc
// clean
{ "text": "\"快速排序算法。\"", "max_chars": 10 }

// fallback
{ "first_message": "帮我写一个快速排序算法", "max_chars": 10 }

// resolve
{ "model_text": "\"快速排序算法。\"", "first_message": "帮我写一个快速排序算法", "max_chars": 10, "title_default": "新对话" }
```

- 缺必填字段 / `max_chars` 非正整数 / `model_text` 既非字符串也非 `null` → 结构化 `bad_args`（不跑方法）。

## 结果

- 成功：`{title}`——标题值（生成或确定性兜底），由消费方 `session-title` 并入其返回值。
- 失败：结构化 `bad_args`。

## 边界

- 不做：模型调用（归消费方 `session-title` 与模型服务）/ 标题落盘（归调用方 `chat`）/ 是否首条的判定（归调用方入口 term）。
- 不写世界、不读投影、无命令面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test    # 协议级 + 纯函数级测试（node --test）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
