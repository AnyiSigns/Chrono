# embedding（本地向量化）

插件化 agent 运行时的**本地向量化服务**：文本 -> 真实 tokenizer 窗口切块 -> granite-97m（int8 ONNX）
-> 384 维 L2 归一向量。本地推理、**不触网**、无写通道；不读投影，输入全由调用方随 bag 传入。

- 身份：`embedding`
- 能力类 / 方法：`embedding` → `embed` / `chunk`
- 命令：无（成员无 `terms/`：无命令即无入口 term，省略该目录）
- 成员：`execute`（Rust 服务 + `launch.mjs`）、`schema`（`embedding.json`）
- pins：无（本地模型，不依赖任何其他身份）
- 状态档：`recomputable`（③ 可重算；无本地持久状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`embedding.embed`（宿主健康判定走协议级 `probe` / `pong`，本字段仅服务自述）

## 模型规格（granite-97m）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 架构 | ModernBERT（12 层，hidden 384，vocab 180000） | `granite-97m/config.json` |
| 向量维度 | 384 | `granite-97m/1_Pooling_config.json` |
| Pooling | CLS token（`last_hidden_state[:, 0]`） | `1_Pooling_config.json` |
| 归一化 | 是（L2） | `granite-97m/modules.json` |
| max_seq_length | 32768（服务侧单次推理护栏见下） | `granite-97m/sentence_bert_config.json` |
| 权重 | `granite-97m/model_quint8_avx2.onnx`（int8 AVX2，≈98 MB） | 本地 |
| 分词器 | `granite-97m/tokenizer.json`（≈25 MB，BPE + `ignore_merges`） | 本地 |

模型清单（`id` / `dim` / `pooling` / `normalize` / `max_seq`）住 `schema/embedding.json` 的 `model`。
向量随 `id` / `dim` 变：索引记录 `{model_id, dim}`，不匹配即整库重建；换模型 = 改清单 + 重编译二进制 + 重建索引。

## 能力契约

```jsonc
// embed 入参（单条或批量；model 缺省 granite-97m）
{ "texts": ["…"], "model": "granite-97m" }
// embed 出参（vectors 与 texts 一一对应，每维 384，已 L2 归一）
{ "model": "granite-97m", "dim": 384, "vectors": [ [/* 384 float */], … ] }

// chunk 入参（window / overlap 按 token 计，缺省 512 / 64）
{ "text": "…", "window": 512, "overlap": 64 }
// chunk 出参（start / end 一律 Unicode 码点偏移；text = 原文本码点切片）
[ { "index": 0, "start": 0, "end": 512, "text": "…" }, … ]
```

- **批量**：`embed` 接受数组；服务内部**逐条推理**（不做 padding），故结果只取决于文本自身、与批次组成无关。
- **确定性**：ONNX Runtime 单线程执行（`intra_threads = 1`、`inter_threads = 1`），tokenizer 单一实现；
  同文本同向量是索引可重算的前提。
- **窗口切块**：用 `tokenizer.json` 的真实 token 计数决定边界；超长逐块、不足一块不补、末块必达文本末尾；
  `start` / `end` 不外泄 token 单位，统一换算为 **Unicode 码点偏移**（与 `memory-store` 条目 `text.slice` 同口径）。

## 推理与打包

- **推理**：`ort`（ONNX Runtime 绑定，`=2.0.0-rc.13`），默认 features 含 `download-binaries` / `copy-dylibs`：
  **构建期**从 pyke CDN 下载 onnxruntime 动态库并缓存到 Cargo 缓存，`copy-dylibs` 把它复制到产物目录
  （`<root>/state/deps/cargo-target/release/`），运行时由同目录的二进制加载。**无运行时下载**。
- **分词**：`tokenizers`（`0.23`，`default-features = false, features = ["fancy-regex"]`）——**避免 onig 的 C 依赖**；
  本 tokenizer 的 `Split` 预处理模式含负向前瞻 `(?!\S)`，必须 `fancy-regex`（纯 Rust）而非 `regex` crate。
- **权重内嵌**：`model_quint8_avx2.onnx` 与 `tokenizer.json` 经 `include_bytes!` 编进二进制（产物 ≈150 MB）。
  构建期输入由宿主**大资产直拷**提供：`schema.embedding.json` 顶层 `assets_manifest` 登记两文件的
  `{path, sha256, size}`，宿主物化时从**投递包源目录**直拷到物化目录并校验 sha256，失败 `deps_failed`。
- **物化**：包根 `Cargo.toml`，宿主物化时跑 `cargo build --release`（`CARGO_TARGET_DIR=<root>/state/deps/cargo-target`），
  `execute/launch.mjs` 据此定位 `embedding[.exe]`；找不到回落包内 `target/release/`。
- **离线限制**：**首次构建需网络**（下载 crates 与 onnxruntime 二进制）；下载缓存与编译产物就位后，
  后续构建 / 运行离线可复现。`~/.cargo` 缓存丢失即需重新联网。
- **平台相关**：二进制与 onnxruntime 库均平台相关（本机为 Windows x64），跨平台须重新构建。

## 入世 / 不入世

| | 内容 |
| --- | --- |
| 入世（世界真源） | `plugin.json` / `package.json` / `Cargo.toml` / `Cargo.lock` / `README.md` / `execute/` 源码 / `schema/` / 模型小 config（`granite-97m/*.json`）/ `granite-97m/LICENSE` |
| 不入世（`.worldignore`，走宿主侧 ③） | `target/`、`tools/`、`test/`、`granite-97m/model_quint8_avx2.onnx`、`granite-97m/tokenizer.json`、`granite-97m/.gitignore` |

二进制**统一走构建**：随包投递的预编译二进制仅作 `assets_manifest` 的复制源，物化以构建产物为准；二进制与权重都不进世界。

## 服务协议

`docs/protocol.md` §二：`hello` / `manifest` / `call` / `result` / `error` / `reload` / `drain` / `bye` / `probe` / `pong`。
stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。`call` 在独立线程执行，控制帧不被长推理阻塞。
模型在握手后**后台预加载**，首个 `embed` 不承担加载延迟；加载失败返回结构化 `error`（`model_load_failed`），服务不崩。

## 测试与 E2E

```bash
npm test                     # 等价 cargo test：分词 / 切块 / 向量 / 相似度 / 协议
node tools/e2e-smoke.mjs     # 宿主装配 E2E（pack + seed + 物化 + cargo build + 协议直连 embed）
```

E2E 重点验证大资产直拷 + `include_bytes!` 全链路：大资产从投递包源目录直拷 -> `cargo build --release` 编译进二进制
-> `launch.mjs` 拉起 -> 握手 -> 协议直连 `embed` 断言 384 维与 L2 范数。

## 已知限制

- **单次推理 token 护栏 2048**：模型 max_seq 是 32768，但 ModernBERT 全局注意力按 O(seq²) 分配，
  32768 token 单次需 ≈51 GB，本机不可行。服务对单条文本截断到 2048 token；超长文本应先 `chunk` 再逐块 `embed`
  （默认窗口 512）。这是服务侧内存护栏，不改变 `schema` 里模型规格 `max_seq: 32768`。
- **逐条推理**：为保「结果与批次组成无关」不做 padding 批处理，吞吐低于真批量；正确性优先。
- **首次构建耗时 / 需联网**：ort 下载与 98 MB `include_bytes!` 使首次 release 构建可能 10–30 分钟。
- **投递源目录丢失须重投**：③ 可重算性 = 「源目录 + 世界源码」；源目录本身丢失则须重新投递（见 `DESIGN.md`）。
