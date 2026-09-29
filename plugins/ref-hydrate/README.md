# ref-hydrate（引用水合原语）

引用水合原语：`hydrate` 沿一段 JSON 里直接出现的 `{"def":hash}` 标记逐跳反向调宿主只读 `host.def.read`，
取 body 组成 `{hash: body}` 闭包。进程内有界缓存、同输入同输出；闭包不完整时 fail-closed，不静默空。
被上层 `chat` / `ui-settings` / `ui-approval` / `loop-policy` 经反向 `port.call` 消费。

- 身份：`ref-hydrate`
- 能力类 / 方法：`ref-hydrate` → `hydrate`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`ref-hydrate.json`）
- `pins`：`{"host": "host"}`（唯一反向调用是宿主只读 `host.def.read`）
- 状态档：`recomputable`（无本地持久状态；缓存为进程内可重建件）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`ref-hydrate.hydrate`
- 运行时零 npm 依赖

## 方法

| 方法      | 入参                         | 返回           | 行为                                                                                             |
| --------- | ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `hydrate` | `{identity, refs?, limits?}` | `{hash: body}` | `refs` 是哈希列表 ⇒ 逐跳解析（展开 body 里的 `{def}`）成闭包；已是对象 ⇒ 原样返回；否则回落 `{}` |

- `identity` 必填：refs 所属身份，宿主 `def.read` 据此做越权门禁。
- 有界缓存按 **身份 + 哈希** 分键：某身份可取回的 body 不得经缓存泄漏给另一身份。
- `limits` 可覆盖默认上限：`max_cache` / `max_hops` / `max_read_batch` / `max_unavailable`。

## 入参（`args`）

```jsonc
{ "identity": "session", "refs": ["<64hex>", "…"] }

// 可选上限覆盖（缺省：缓存 4096 / 逐跳 10000 / 单批 256 / 不可用 64）
{ "identity": "loop-policy", "refs": ["<64hex>"], "limits": { "max_hops": 512 } }
```

- 缺 `identity` / `limits` 非对象 / 上限非正整数 → 结构化 `bad_args`（不跑方法）。

## 结果与失败

- 成功：`{hash: body}` 闭包（内容寻址、逐跳展开）。
- 失败：`def_unavailable`——宿主 `def.read` 对部分哈希回 missing / denied 或传输失败，
  已处理但最终不在闭包里的哈希（去重、按上限截断）随错误上报，调用方据此重解析或拒绝。

## 边界

- 不做：判断哪些身份 / 槽需要水合（归各消费方）/ 落地缓存（归宿主或消费方）/ 写世界。
- 不读投影、不写世界、无命令面；除 `host.def.read` 外无反向调用。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test    # 协议级 + 水合器级测试（node --test）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
