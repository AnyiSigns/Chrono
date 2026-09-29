# dedup（去重原语）

去重原语（纯函数 + 一个可选向量后端）：`dedup` 从 `incoming` 里挑出与 `reference` 及已接受项都不重复的
项（保序）。有向量后端时用**余弦阈值**判定近似重复；后端缺失 / 失败回落**精确文本去重**——去重是尽力而为，
权威重去重归记忆维护服务。向量经反向 `port.call embedding.embed` 取得。被上层压缩门面 `compress` 经反向
`port.call` 消费；自身不读投影、不写世界、不自取时钟。

- 身份：`dedup`
- 能力类 / 方法：`dedup` → `dedup`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`dedup.json`）
- `pins`：无（`"pins": {}`）；跨身份依赖走 `needs.embedding`（`embedding` → `embedding`，`one`）
- 状态档：`recomputable`（无本地持久状态；同文本同向量）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr； stdin EOF 即自退出）
- 健康探针自述：`dedup.dedup`
- 运行时零 npm 依赖

## 方法

| 方法    | 入参                                        | 返回                | 行为                                                                                           |
| ------- | ------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `dedup` | `{incoming, reference, model?, threshold?}` | `{accepted, dedup}` | 精确文本去重打底；`incoming` 与 `reference` / 已接受项做余弦比对（≥ `threshold` 视为重复丢弃） |

- `dedup` 字段语义：`"vector"` 表示本次去重中**至少有一次**判定实际走了向量余弦；仅当所有判定都回落精确文本时才为 `"text"`。
- 向量取用条件：有后端且（既有条目非空或候选 ≥ 2）；否则不必取向量，直接文本路径。
- 后端缺失 / 失败 → 精确文本去重（结构化 `BackendError` 内部消化，只在日志留痕）。
- 纯函数 + 确定性后端：不取时间 / 随机，同输入同输出。
- 单次 `embedding.embed` 反向调用等待上限 30000ms，严格小于 `dedup.dedup`（35000ms）。

## 入参（`args`）

```jsonc
{
  "incoming": ["alpha!", "beta"],
  "reference": ["alpha"],
  "model": "granite-97m",
  "threshold": 0.9,
}
```

- `incoming` / `reference` 非字符串数组 / `threshold` 越界 / `model` 非空串 → 结构化 `bad_args`（不跑方法）。

## 结果

- 成功：`{accepted, dedup}`——接受的新条目（保序）与实际去重路径，由消费方并入其返回值。
- 失败：结构化 `bad_args`。

## 边界

- 不做：向量计算（归 `embedding`）/ L1 / L2 读写（归 `short-memory`）/ 权威重去重（归记忆维护服务）。
- 不写世界、不读投影、无命令面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test    # 协议级 + 纯函数级测试（node --test）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
