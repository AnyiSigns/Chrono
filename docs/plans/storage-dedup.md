# 存储去重：源码字节内容寻址与物化回收

> 口径来源：`docs/kernel.md`（内核设计，唯一权威）与 `docs/host.md`（载体设计）。
> 本文件属 `docs/plans/`，只写"怎么做"，不参与设计口径；冲突时以设计文档为准。
> 目的：为「源码 watcher 热更」清出前置条件——一次换代的增量成本与实际改动字节成正比，
> 而不是与整棵源码树成正比。

---

## 一、现状量化

| 项 | 体积 / 数量 | 性质 |
| --- | --- | --- |
| `state/` 合计 | 1765 MB | — |
| `state/deps/cargo-target` | 1330 MB | 正常构建缓存（③） |
| `state/runtime/materialized` | 418 MB / 89 个目录 | 每世代一棵完整源码树副本（③） |
| `state/world/journal.jsonl` | 12 MB / 仅 187 条 entry | 源码字节内联进 `entry.args` |
| 最大单条 entry | 253 KB | 某 README 的 markdown 正文 |
| `frames.ts` 在盘上出现 | 70 次 | materialized 逐世代整树复制 |

关键事实：

- `packages/host/assembly/materialize.ts` 的 `materializeCommit`（:11）用 `writeFileSync` 逐文件写
  （文本直写、base64 先解码），`rmSync`（:23、:33）只清 staging，**没有任何按可达性回收的逻辑**。
- 内核本就是内容寻址：`H`（`packages/kernel/hash.ts:138`）与 `entryHash`（`packages/kernel/journal.id.ts`）。
- `state/world/` 下只有 `journal.jsonl`，无 `base.json`、无 `cold/`——`compact` 从未在此世界跑过。

---

## 二、目标形态

### 2.1 CAS 布局

```
state/
├── world/                          journal + base + cold（真源）
├── blobs/<sha256>                  源码字节本体（内容寻址；只增；离线回收）
├── assets/<sha256>                 用户资产（不变）
├── runtime/materialized/<commitHash>/  工作副本（③；文件硬链接共享 CAS 字节）
└── deps/                           依赖 / 构建缓存（③）
```

- `state/blobs/` 与 `state/assets/` 机械同构（64-hex 命名、只增、离线 GC），但**保留策略不同**：
  源码字节与用户资产同为 ④（不可重算），都必须在备份范围内、都不在启动时自动删。
- 备份口径随之改变：**备份 = `state/world/` + `state/blobs/`（+ `state/assets/`）**。
  仅备份 `world/` 不再等于备份世界——源码字节在 `blobs/`。

### 2.2 entry / def 形状前后对比

文件 blob def（文本）：

```
before  { op:'put', args:{ body:"<文本>" } }          argsHash = H({ body:"<文本>" })      字节在链上
after   { op:'put', args:{ body:{ kind:'blob', sha256:"<64hex>", size:<int> } } }
                                                     argsHash = H({ body:{…} })           字节在 state/blobs/<sha256>
```

文件 blob def（二进制）：

```
before  { body:"<base64>", enc:'base64' }
after   同上 pointer 形态（CAS 存原始字节，去掉 base64 的 1.33× 膨胀）
```

tree entry：**不变**，仍是 `{ name, mode:'file'|'dir', hash:<def 键> }`，指向 blob def 键。
commit def：**不变**，仍是 `{ body:{ tree, meta } }`。

pointer def 的字段：

- `kind:'blob'`：唯一判别位。旧读取器要求 `typeof body === 'string'`，遇对象体**安全失败**（`bad_blob`），
  不会把哈希串当文件内容写出。
- `sha256`：原始字节摘要，兼作 CAS 文件名与读取校验。
- `size`：字节长度，读取时对照，防截断。
- def 键 = `H(pointer def)`，与 `sha256` 不同。tree 仍引用 def 键，故 **tree / commit 的哈希结构与
  结构共享（未变目录子树按哈希复用）完全不变**。

### 2.3 物化策略

`materializeCommit` 对每个 file entry 解析 blob：

- **inline（旧世界）**：维持逐字节写，兼容不改。
- **pointer**：读 `state/blobs/<sha256>` 并校验 `size`；目标不存在时以硬链接（`linkSync`）接入物化树。
  `EXDEV` / `EPERM` / `EMLINK` / 目标文件系统不支持 → 回退普通复制（`copyFileSync`）。
  `COPYFILE_FICLONE`（reflink）在支持的平台尝试；**win32 上 libuv 不暴露块克隆，实际退化为复制**，
  故 Windows 的主力共享机制是硬链接。同一 blob 在多个世代里因此指向同一 inode，
  `frames.ts` 的 70 份副本塌缩成 70 个链接。
- 共享前提是 CAS 文件不可变：物化时把源码文件置只读（POSIX `0444`、Windows 清写位），
  `.chrono-materialized` 标记语义不变；服务对物化目录的写只允许新增文件，不得覆盖源码文件。
- CAS 缺失 → `blob_missing`（与 `asset_missing` 同口径，属已知限制）；inline 旧世界不依赖 CAS。

### 2.4 回收策略

两类回收严格分开：

- **materialized（③，可重算）**：每个身份保留 active 代码世代 + 前 N 代
  （`MATERIALIZED_KEEP_GENERATIONS`，缺省 5）供快速回滚，其余目录删除；只删 64-hex 命名的目录、
  跳过 staging。触发点：启动时（抢锁后、装配前）或离线命令；**绝不在 run 中删**。
- **blobs（④，不可重算）**：只做**可达性**回收——沿每个身份的每个世代的 `commit.body.tree`
  递归遍历 `world.defs`，收集被引用 blob 的 `sha256`，删除不在集合内的 64-hex 文件。
  离线、持锁，不在启动时自动删（与 `assets gc` 同规）。入世被拒但已落盘的孤儿字节由此清理。
- 关键：**回滚承诺不由 materialized 承担**。`set_active` 可指回任意世代，materialize 恒可由
  「① 的指针 def + CAS 字节」重建；保留前 N 代只是缓存命中优化。因此 blobs 的可达集覆盖
  **全部世代**（不是 active + N）——回滚可命中任意世代。

---

## 三、与内核三承诺和不变量的逐条对照

三承诺：

| 承诺 | 影响 | 说明 |
| --- | --- | --- |
| 改坏了能退 | 不受影响，依赖扩展 | 回滚仍是 `set_active` 一次追加；物化改由 ① + CAS 重建。新增依赖：CAS 必须保留全部世代的字节 |
| 非法进不来 | 不受影响 | `put` 的形态检查只要求 `body` 为 Json；pointer def 合法，四步机械校验一字不改 |
| 历史改不掉 | 不受影响 | `argsHash` 口径不变，`entryHash` 只吃 `argsHash`，链格式零改动 |

不变量（按 `kernel.md` §十七 分组）：

| 不变量 | 影响 | 说明 |
| --- | --- | --- |
| 重放一致 | **语义细化，不破** | `replay` 仍逐字段重建世界（含 pointer def）；"逐字节可重放"改由 `sha256` 校验 CAS 字节保证，字节本体不在链上——与 `host.md` 资产「重放只复现引用，不复现字节」同口径 |
| 失败不留痕 | 不破 | CAS 写在世界之外；批次失败世界分文未动，至多留孤儿字节（GC 清理） |
| 纯与无外部 | 不破 | 内核零改动；CAS 的 IO 全在宿主 |
| 依赖形状 | 不破 | `defs` / `ids` 赋值仍只在 `journal.ts`；宿主不写世界 |
| 不扩权 | 不破 | 与 caps 无关 |
| 链格式 | 不破 | `argsHash` 口径、唯一回填点、entry 不可变均不变 |
| 留痕不进世界 | 不破 | 与 `note` 无关 |

唯一需要重新论证的是「重放一致」里"逐字节"的含义：从「链上含字节」变为「链上含哈希 + CAS 按哈希
可验证还原」。**若要求链上字节自足、可脱离 CAS 独立重放，则本方案不能做**——这是硬边界，也是第四节的取舍点。

---

## 四、张力的正面回答

`kernel.md:162` 写「源码必须在 ① 不因大而外迁」，三条理由是回滚承诺 / 依附判定 / 无特权；
同一文档的对策四又写「大字节不走 `put`（③④，链只承诺哈希值不承诺谁算的）」。两者在源码这一具体类别上冲突。

**方案下 ① 里留下的是**：`commit` def、`tree` def、每个文件的 blob **指针 def**
（`{kind:'blob',sha256,size}`）、term def、schema def，以及 `Identity.sig` / `pins`。
即源码的**声明与内容身份**全在 ①，**字节本体**在 ④ `state/blobs/`。

三条理由如何仍然成立：

- **回滚承诺**：`set_active` 指回旧 payload → 旧 `commit` → `tree` → blob 指针 def（① 只增不删）
  → CAS 字节。动作仍是"一次记账"，前提扩展为"① 的指针 + CAS 保留"。
  **必须写死**：源码字节按 ④ 保留（可达集 = 全部世代），不得按 ③ 丢弃。
- **依附判定**：`stale(def, world, id)` 吃 `sig` / `pins`；换代换的是 `commit` / `tree` / blob 指针 def
  的**键**，`sig` / `pins` 比对照常检出失效。指针 def 的键含 `sha256`，内容一变键就变，
  检出能力比旧内联形态只强不弱。
- **无特权**：CAS 不是源码专属例外，而是 ③④ 大字节的通用机制（用户资产已在用）；
  源码只是把已有通用规则套到自己身上，不再是唯一必须内联的类别。差异只剩**保留策略**，
  而 `kernel.md` 明说 ③④ 的区别只在宿主保留策略。

**是否冲突**：与 `kernel.md:162` 的**字面表述冲突**（字节确实外迁了），与其对策四一致（链只承诺哈希）。两种口径：

- **口径甲（改设计文档，推荐）**：把该句细化为「源码的**声明与内容身份**必须在 ①；字节本体可住 ③/④，
  但源码字节按 ④ 保留、必须随世界一起备份」，三条理由按上文重述。代价：改 `kernel.md` 一句 +
  `host.md` 目录与备份段。收益：四个目标全满足，RAM 墙解除（`defs` 由 O(所有源码字节) 降为 O(指针数)）。
- **口径乙（改方案，不动设计文档）**：字节留在 ①，只做去重 + 硬链接 + 压缩。收益：materialized 的
  418 MB 可共享回收；相同内容重复写本就被 `dup` 短路、不新增 entry。代价：**不满足目标 1 与目标 4 的
  RAM 维度**——`defs` 仍持有全部去重后的源码字节，watcher 下 RAM ∝ 历史改动字节，journal 首次写入仍内联大字节。
  等于放弃本方案的前置意义。

取舍建议：**取甲**。若坚持不改 `kernel.md`，则须显式把目标 1 与目标 4 的 RAM 部分移出本次范围，
只交付目标 2 / 3。

---

## 五、迁移路径

- **向后兼容（必须做到）**：读取侧（`materialize`、`decl.ts` 的 `resolveTreeBlob`、`host.source.read`）
  同时支持 inline 与 pointer 两种 blob def。旧世界（187 条 / 12 MB / inline）**可不迁移直接跑**：
  replay 得旧 defs，物化走 inline 分支；新写入用 pointer + CAS，混合世界一致；
  base / journal 的 `worldRev` 自校在各自形态内自洽。
- **旧数据回收无需迁移即可做**：`state/runtime/materialized` 的 89 目录 / 418 MB 是 ③，
  可立即按 §2.4 回收（需要时从旧世界的 inline def 重建），不依赖 CAS。
- **升级后的一次性代价**：blob def 键随形态改变，`ingest.ts` 的 `unchanged` 判定
  （比较最近代码世代 payload 与本包 commit 哈希）会在升级后首次入世失效一次，
  即使源码未变也会产生一个新世代；每个身份一次，可接受。
- **一次性迁移工具（可选，后置）**：把旧 inline 世界重建成 pointer 世界。由于 def 键随形态改变，
  重建即**上层重建世界**（`kernel.md` §十八）：逐世代物化 → 重新入世为 pointer → 产新链，
  并重解析 `pins`（旧 `pins` 指向旧 commit 键）。风险高，须全量 `verify` 后原子换账。
  **首期不做**：旧 12 MB 保留但不再增长，新数据已受控；待 watcher 稳定后再评估。
- 明确：不迁移不丢数据，也不阻塞目标 2 / 3；只是旧字节不享 CAS 与硬链接收益。

---

## 六、触碰文件清单

**内核：零改动**（推荐路径）。理由见 §三：`put` 接受任意 Json body，pointer def 不触任何内核机制；
改内核属最高风险，非必要。若日后必须让内核认识 blob，只能新增 `Def` 字段或 op，那会改动 `argsHash` /
链格式，须按"换链"裁决，风险等级最高，本方案不采用。

宿主（均为宿主侧 ③/④ 与数据约定，风险中等）：

| 文件 | 改动性质 |
| --- | --- |
| `packages/host/assembly/source.ts` | `packSourceDir` 产 pointer def + 原始 `sha256` / `size`，回传待落 CAS 的字节；新增 blob 形态判别与摘要计算（纯函数） |
| `packages/host/assembly/ingest.ts` | 入世计划携带 `blobs` 清单；dry-run 不写 CAS；调用方在 `commit` 前落 CAS |
| `packages/host/assembly/materialize.ts` | blob 解析 inline / pointer；硬链接 + 回退复制；只读置位；CAS 缺失 `blob_missing` |
| `packages/host/assembly/decl.ts` | `resolveTreeBlob` 支持 pointer（经 CAS 读文本） |
| `packages/host/assembly/service-launcher.ts` / `runtime.ts` | 传递 `blobsDir` |
| `packages/host/host-capability.ts` | `source.read` / `blobBytes` 支持 pointer → CAS |
| `packages/host/blobs.ts`（新） | CAS put / get / gc + 世代可达性遍历 |
| `packages/host/paths.ts` | 增 `blobsDir` |
| `packages/host/offline.ts` | `boot blobs gc` / `boot materialized gc`；`seed` / `pack` 落 CAS |
| `packages/host/assembly/index.ts` | 导出新助手 |
| `packages/host/compact.ts` / `ledger/base.ts` | 无键改；新世界的 `base.json` 自动变小。若需显式格式位则 bump `BASE_VERSION`（低风险） |

文档（设计权威，需同步；本文件只提出、不代改）：

| 文件 | 改动 |
| --- | --- |
| `docs/kernel.md` §八 | 按口径甲细化"源码在 ①"一句（声明 / 身份 vs 字节本体） |
| `docs/host.md` §三 | 增 `state/blobs/`；备份口径加 `blobs/`；**修正**依赖缓存位置：§三写"依赖住 `state/runtime/`"与 §五写"住 `state/deps/`"矛盾，实际磁盘为 `state/deps/`，应以 §五为准改 §三 |
| `docs/host.md` §五 | 增源码 CAS、物化硬链接与回退、materialized 与 blobs 回收口径 |

---

## 七、分步实施与验证

测试基线：`packages/host` 的 `vitest run` 与 `tsc --noEmit`（见 `packages/host/package.json`）。

1. **CAS 存储层**（`blobs.ts` + `paths.blobsDir`）。验证：新增单测（put / get / 幂等 / 64-hex 校验）；
   现有测试全绿。
2. **入世产 pointer + 落 CAS**。验证：`source.ts` 单测断言 pointer 形态与 `sha256`；同内容两次入世命中 `dup`；
   `validate_package` 不写 CAS；`host-capability.test.ts` 的 `source.read` 改读 pointer。
3. **物化解析 pointer**（先只走复制路径）。验证：`materialize.test.ts` 增 pointer 用例（文本 + 二进制，
   二进制不再走 base64）。
4. **物化硬链接 + 回退**。验证：`statSync(dest).nlink >= 2`（同卷）；注入 linker 接缝模拟 `EXDEV`，
   断言回退复制；只读置位断言（写源码文件失败）。
5. **向后兼容读取**。验证：构造 inline 旧 journal，replay + 物化成功；`host-integration.test.ts` 跑混合世界。
6. **materialized 回收（active + N）**。验证：保留集断言；删除后 `set_active` 指回被删世代仍能重新物化；
   `host-generation.test.ts` 回滚路径。
7. **blobs 可达性 GC + 离线命令**。验证：孤儿字节被删、被引用字节保留；`assets gc` 行为不回归。
8. **文档同步**（`kernel.md` / `host.md`）。验证：文档评审，不涉代码。

每步独立可交付。1–4 完成后，watcher 的换代增量即已 ∝ 改动字节（tree 的结构共享本就复用未变子树）；
5–7 补齐兼容与回收。

---

## 八、风险与不做的事

**风险**

- **硬链接与就地写**：服务覆盖物化目录里的源码文件会经同一 inode 污染 CAS。缓解：源码文件只读；
  但标记无法检出内容改动，属残余风险。
- **Windows 限制**：硬链接要求同卷、不支持目录、部分文件系统（FAT / exFAT / 网络盘）不支持 → 复制回退
  （不省空间但正确）；reflink 在 win32 不可用。
- **备份缺口**：`state/blobs/` 若不随 `state/world/` 一起备份，源码字节不可恢复（与 assets 同风险），
  须在文档与运维写明。
- **混合形态长期共存**：inline 与 pointer 两条读取分支须长期保留，直到世界重建；漏改一处即读错
  （`kind:'blob'` 判别使漏读失败而非静默写错）。
- **CAS 只增**：源码字节保留全部世代，watcher 长期运行下 `state/blobs/` 持续增长；最终回收只能靠
  世界重建，属既有"世界只增不减"税。
- **孤儿字节**：入世被拒但 CAS 已写，由离线 GC 清理，期间占盘。
- **`worldRev` 形态差异**：同一内容在新旧形态下得到不同 `worldRev`（def 键不同），跨形态比较无意义；
  快照在各自形态内自洽。

**不做的事**

- 不改内核（不加 `blob` 字段、不加 op、不改 `argsHash` 与链格式）。
- 不做内容定义分块（CDC）或跨机去重；去重粒度是文件。
- 不自动在启动时删 blobs（与 `assets gc` 同规）。
- 不在首期做旧世界的一次性重建工具。
- 不做沙箱 / 文件系统隔离；`state/blobs/` 与物化目录仍是路径约定。
- 不把源码字节并入 `state/assets/`（保留策略不同，故分目录）。
