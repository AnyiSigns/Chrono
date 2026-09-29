# tokenizer（真实分词与窗口切块）

插件化 agent 运行时的**分词与切块服务**：文本 -> 真实 tokenizer 编码（ids / mask / 偏移）/ 窗口切块
（按真实 token 计数决定边界，输出 **Unicode 码点偏移**）。本地计算、**不触网**、无写通道；
不读投影，输入全由调用方随 bag 传入。

- 身份：`tokenizer`
- 能力类 / 方法：`tokenizer` → `encode` / `chunk`
- 命令：无（成员无 `terms/`：无命令即无入口 term，省略该目录）
- 成员：`execute`（Rust 服务 + `launch.mjs`）、`schema`（`tokenizer.json`）
- pins：无（本地分词器，不依赖任何其他身份）
- 状态档：`recomputable`（③ 可重算；无本地持久状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`tokenizer.encode`（宿主健康判定走协议级 `probe` / `pong`，本字段仅服务自述）

## 能力契约

```jsonc
// encode 入参（add_special_tokens 缺省 true：加 CLS / EOS）
{ "text": "…", "add_special_tokens": true }
// encode 出参（ids / mask / offsets 逐 token 一一对应；offsets 为 [start,end] 字节偏移）
{ "ids": [179934, …], "mask": [1, …], "offsets": [[0, 2], …] }

// chunk 入参（window / overlap 按 token 计，缺省 512 / 64）
{ "text": "…", "window": 512, "overlap": 64 }
// chunk 出参（start / end 一律 Unicode 码点偏移；text = 原文本码点切片）
[ { "index": 0, "start": 0, "end": 512, "text": "…" }, … ]
```

- **单一实现**：`encode` 与 `chunk` 用同一份分词器（`tokenizer.json`），token 计数与窗口边界一致。
- **确定性**：同一分词器、同输入同输出；这是上层 `embedding` 与向量索引可重算的前提。
- **窗口切块**：用真实 token 计数决定边界；超长逐块、不足一块不补、末块必达文本末尾；
  `start` / `end` 不外泄 token 单位，统一换算为 **Unicode 码点偏移**（与 `memory-store` 条目 `text.slice` 同口径）。

## 推理与打包

- **分词**：`tokenizers`（`0.23`，`default-features = false, features = ["fancy-regex"]`）——**避免 onig 的 C 依赖**；
  本 tokenizer 的 `Split` 预处理模式含负向前瞻 `(?!\S)`，必须 `fancy-regex`（纯 Rust）而非 `regex` crate。
- **分词器内嵌**：`granite-97m/tokenizer.json`（≈25 MB）经 `include_bytes!` 编进二进制。
  构建期输入由宿主**大资产直拷**提供：`schema/tokenizer.json` 顶层 `assets_manifest` 登记该文件的
  `{path, sha256, size}`，宿主物化时从**投递包源目录**直拷到物化目录并校验 sha256，失败 `deps_failed`。
- **物化**：包根 `Cargo.toml`，宿主物化时跑 `cargo build --release`（`CARGO_TARGET_DIR=<root>/state/deps/cargo-target`），
  `execute/launch.mjs` 据此定位 `tokenizer[.exe]`；找不到回落包内 `target/release/`。
- **离线限制**：**首次构建需网络**（下载 crates）；下载缓存与编译产物就位后，后续构建 / 运行离线可复现。
- **平台相关**：二进制平台相关（本机为 Windows x64），跨平台须重新构建。

## 入世 / 不入世

|                                      | 内容                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 入世（世界真源）                     | `plugin.json` / `package.json` / `Cargo.toml` / `Cargo.lock` / `README.md` / `execute/` 源码 / `schema/` |
| 不入世（`.worldignore`，走宿主侧 ③） | `target/`、`tools/`、`test/`、`granite-97m/tokenizer.json`、`granite-97m/.gitignore`                     |

二进制**统一走构建**：随包投递的预编译二进制仅作 `assets_manifest` 的复制源，物化以构建产物为准；二进制与分词器都不进世界。

## 服务协议

`docs/protocol.md` §二：`hello` / `manifest` / `call` / `result` / `error` / `reload` / `drain` / `bye` / `probe` / `pong`。
stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。`call` 在独立线程执行。
分词器在握手后**后台预加载**；加载失败返回结构化 `error`（`tokenizer_load_failed`），服务不崩。

## 测试

```bash
npm test     # 等价 cargo test：分词 / encode / 切块 / 协议
```

## 已知限制

- **首次构建需联网**：需要下载 `tokenizers` 依赖；缓存就位后离线可复现。
- **投递源目录丢失须重投**：③ 可重算性 = 「源目录 + 世界源码」；源目录本身丢失则须重新投递。
