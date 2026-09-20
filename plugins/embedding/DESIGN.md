# #20 `embedding`（本地向量化）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 20 / `embedding` |
| 语言 | **Rust**（`ort` / ONNX 推理；与 #25 同路：源码 + `Cargo.toml` 入世，`target/` 与权重走宿主侧 ③ 依赖缓存） |
| 职责 | 本地向量化服务：文本 -> 窗口切块 -> granite-97m（int8 ONNX）-> 384 维 L2 归一向量 |
| 依赖 | pins 无（本地模型，不依赖 #12）；`<-` 21（建 / 重建索引）、22（查询向量）、23（去重合并）、19（`summarize` / `extract` 去重用向量） |
| 成员 | execute（Rust 二进制 + 模型小 config）、schema |
| 能力类·方法 | `implements: ["embedding"]`，`methods: {embedding:["embed","chunk"]}` |
| 命令 | 无 |
| schema | `schema/embedding.json`（模型清单：`id` / `dim` / `pooling` / `normalize` / `max_seq` / `build_ref`（构建期权重来源，仅供重建时取权重）） |
| 机制 | 见下「模型规格 / 部署 / 分块 / 能力契约」 |
| 边界 | 不做：存储 / 检索 / 压缩 / 重排；**不触网**（本地推理） |
| 验收 | 1) 同文本同向量（确定可回放）；2) 输出 384 维且 L2 归一；3) 中文可检索；4) 长文本按窗口切块不丢尾；5) 换模型版本（`id`/`dim` 变）可辨认并触发重建；6) **权重与编译二进制都不进世界**，只有源码入世 |
| 状态 | 细节设计（2026-09-19，本地 granite-97m / Rust） |

## 模型规格（granite-97m）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 架构 | ModernBERT（12 层，hidden 384，vocab 180000） | `granite-97m/config.json` |
| 向量维度 | **384** | `1_Pooling_config.json: word_embedding_dimension` |
| Pooling | **CLS token** | `pooling_mode_cls_token: true` |
| 归一化 | 是（`2_Normalize`） | `modules.json` |
| max_seq_length | 32768 | `sentence_bert_config.json` |
| 权重 | `model_quint8_avx2.onnx`（int8 AVX2，≈98 MB） | 本地 |
| 分词器 | `tokenizer.json`（≈25 MB） | 本地 |

## 部署与打包

- **运行时**：Rust 构建为二进制（ONNX 推理用 **`ort`（ONNX Runtime 绑定）**）；**模型权重与 tokenizer 用 `include_bytes!` 内嵌进二进制**（编译期输入），产物约 ~150 MB；`start` 指向该二进制；宿主不认识语言，只按 `start` 拉起。
- **插件自带本地依赖（破例一次）**：`ort` 需要 `onnxruntime` 动态库，按「插件自带库（类似 `node_modules`）」处理——住宿主侧 ③、不入世；这与「二进制单文件」目标有出入，本轮接受。
- **无运行时下载**：权重随二进制走，**首次安装不下载**（npm 包直接带该二进制）。
- **模型可换、不堵死**：官方默认 granite-97m、**不内置多模型**；模型清单住 `schema/embedding.json`，换模型 = 改清单 + 重编译二进制 + 重建索引（agent 本就可改插件）。

**入世 / 不入世（打包口径）**

| | 内容 | 说明 |
| --- | --- | --- |
| **入世（世界真源）** | `plugin.json` / `package.json` / 锁 / `README.md` / `execute/` 的 **Rust 源码 + Cargo 清单** / `schema/` / `terms/` / 模型小 config（`config.json` / `1_Pooling_config.json` / `modules.json` / `sentence_bert_config.json` / `special_tokens_map.json` / `tokenizer_config.json`） | 源码可回滚 = 一条记账 |
| **不入世（宿主侧 ③，`.worldignore` 排除）** | 编译产物二进制（内嵌权重，~150 MB）、ONNX 运行时库、构建期权重输入 `granite-97m/model_quint8_avx2.onnx` / `tokenizer.json` | 大字节 / 第三方依赖 / 构建产物 |

- **二进制放 `execute/` 随 npm 包投递**（本机开箱可跑、免下载），但**不进世界**。
- **编译期权重输入**：`include_bytes!` 要求权重文件在**构建机**存在；权重仍被 `.gitignore` / `.worldignore` 排除，不入仓库、不入世界。从源码重建时需先取一次权重（仅构建者）。
- **代价（明确记账）**：二进制 ~150 MB 且平台相关；换模型 = 换权重 → 重编译重打包；构建内存 / 时间上升。
- **③ 重建的现实**：宿主不认识语言、不做编译 ⇒ 二进制由包 / 安装器提供；纯从世界重装需重新获取 ③（源码在，可由外部工具链重建，权重需构建期获取）。
- **版本锚**：向量随模型 `id` / `dim` 变；索引记录 `{model_id, dim}`，不匹配即整库重建（宿主侧 ③ 可重算，无需迁移世界）。**内嵌模型换版 = 重编译二进制 + 重建索引**。

## 分块（窗口切块）

- 默认窗口 **~512 token、overlap 64 token**（可配）；按 `tokenizer.json` 真实计数，不用字符近似。
- 超长文本切块后**逐块出向量**（记忆条目以块为粒度，检索返回块）；不足一块不补。
- 切块确定（同文本同块集），保证索引可重算一致。
- `chunk(text) -> [{index, start, end, text}]` 可单独调用（供 #21 建索引 / #23 去重前统一切）；**切窗用真实 token 计数，但输出的 `start` / `end` 一律是 Unicode 码点偏移**（与 #21 条目 `text.slice` 同口径；token 只用于决定窗口边界，不外泄为偏移单位）。

## 能力契约

```jsonc
// embed 入参
{ "texts": ["…"], "model": "granite-97m" }        // 单条或批量
// embed 出参
{ "model": "granite-97m", "dim": 384,
  "vectors": [ [/* 384 个 float */], … ] }          // 已 L2 归一
```

- 批量上限与并发由宿主预算 / 服务自设约束（本插件 pins 无、不依赖 #12；服务侧自设，不取时间、不用随机，保可回放）。
- **确定性**：CPU int8 推理同输入同输出；同文本同向量是索引可重算的前提。
