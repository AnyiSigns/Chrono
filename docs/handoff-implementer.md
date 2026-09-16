# 实现者交接提示词

> 直接把本文作为首条 prompt 喂给实现 agent。评审 agent 另有一份，不混用。
>
> **先读三份文档再动手**：`docs/kernel-design.md`（What/Why）、`docs/kernel.md`（可编码规格，本轮已落全部行为口径）、`docs/kernel-next-steps.md`（本轮任务表与不许做的事）。

---

## 0. 你的角色

你是**实现方**（`kernel.md` §5.4 定的角色）。三条铁律：

1. **不写测试、不改测试、不为测试加导出或开关。** 测试由评审方写——他们从 `index.ts` 导入、打公共面。你只交付非 `*.test.ts` 的实现文件。
2. **规格已经写到可判对错。** 本轮所有行为口径（note 载荷、verify 不抛、dup 短路、四档+规矩 A/B、会话语义、不变量 16）已全部落进 `docs/kernel.md`——你**对着规格码**，不自己定口径。发现规格有缺口 → 回填规格（这是你的活），不靠测试迁就。
3. **绝对性能数字（ms / MB·s⁻¹）一律不得写进 `kernel.md` 规范文本**，只写比率与量级并注明测机。

## 1. 已核验的现场事实（省你一遍确认）

| 主张 | 核验结果 | 出处 |
|---|---|---|
| kernel.md 状态 `AM` | 已提交 `bfa3997`；本轮规格编辑后提交 `8874fcf` | `git log --oneline -3` |
| `commit.form.ts:70` note 行 `keys.length === 0` | ✓ 属实 | `packages/kernel/commit.form.ts:70` |
| `journal.ts:76-99` verify 无 try/catch，snapshot throw 穿出 | ✓ 属实 | `packages/kernel/journal.ts` |
| `journal.apply.ts:50-56` snapshot 自校 throw `world_rev_mismatch` | ✓ 属实 | `packages/kernel/journal.apply.ts` |
| 既有 183 测试全绿 | ✓（`npm test` = 11 文件 183 用例） | 上轮基线 |
| T2 放开 note 载荷不撞既有断言 | ✓ 核过：commit.test.ts:136 只测空 note ok；反例表不含 note 载荷→bad_form；journal.a/b 里的 payload note 走 applyEntry 直路（不经 hasForm） | grep 全 `*.test.ts` |
| T3 verify 不抛不撞既有断言 | ✓ 核过：`expectThrow`（journal.a:59-62）只对 `h.apply`（applyEntry 层）；`verify` 路径无 throws 断言 | grep `world_rev_mismatch` in tests |
| `host.ts` 已含 T4#1(Buffer 切行) + T4#2(快启动 replay-only) + T6 pins:{src} | ✓ 上轮已改 | `experiment/host.ts` |
| 机器：8.4GB 总内存，空闲 ~1.0GB | X10（100k def）本地跑不了；T8 真数需换机 | 上轮 bench |

## 2. 本轮规格已完成（你不用再做）

T1(a–i)、T7、T2 同步、T3 口径、T5 口径已全部落进 `docs/kernel.md` 并提交 `8874fcf`：

- **§0.4** 四档表 + 规矩 A（pins 唯一记录处）+ 规矩 B（留痕走链）+ 会话税句
- **§7** pins 注释改为"结构性依赖唯一记录处"
- **§11.2②** 补"能力边界不是许可"
- **§10.2 / §11.2 形状表** note 行改为"任意 JSON 对象 = 留痕载荷"；"载荷都小"句补 note 例外
- **§22 / D1** 可达闭包行补"规矩 A 使上层沿 pins 得闭包"
- **§10.7** 归档协议加第 6 条（保留集 = 尾段引用 ∪ active 闭包，沿 pins/payload/sig/schema 遍历）
- **§4.5** 加字节保真硬契约（编解码器合法、语义往返非法）
- **§10.1** verify 签名旁注"不抛"；**§10.4** snapshot 行重写"verify catch 转返回码"；**§19** replay 补 `@throws world_rev_mismatch`；**§20** 伪代码包 try/catch；**§10.5** 验收清单加 3 条
- **§10.3** dup 短路段；**§10.5** 加计数桩条
- **§14** 行 16（留痕不进世界，规矩 B 可执行定义）+ 计数桩段补 §14-16 说明
- **§15 / §5.4 / §5.1** 不变量数 15→16
- **§10.6** 分支/编辑重放两行

## 3. 你要做的：三处内核代码 + 宿主四件 + bench 扩展

### T2 · 内核：`note` 放行载荷（1 行）

```
文件: packages/kernel/commit.form.ts:70
现状: note: (c) => c.keys.length === 0,
改为: note: () => true,   // 任意 JSON 对象：hasForm 前置（第 43 行）已保证 args 是非 null、非数组对象
规格: §11.2 形状表 note 行 + §10.2 note 行（已落）
回退: 无条件安全（放宽形态向后兼容）
测试: 评审方补 6 条（§11.4 验收清单已写死，见规格）
```

### T3 · 内核：`verify` 不再抛（2 行）

```
文件: packages/kernel/journal.ts — verify() 函数体
现状: applyEntry 的 KernelError（snapshot world_rev 不符）穿出 verify
改为: 把循环+段末 worldRev 核对包进 try { … } catch (e) { if (e instanceof KernelError) return { ok:false, error:e.code }; throw e }
      replay 保持抛——它的契约就是抛（§19），但 @throws docblock 补 'world_rev_mismatch'
规格: §20 伪代码已写 try/catch 版本；§10.1 旁注 + §10.4 行已落
```

### T5 · 内核：`dup` 短路（局部，`journal.apply.ts` applyBatch）

```
文件: packages/kernel/journal.apply.ts — applyBatch() 段 1 之后、段 2 之前
做法: 若 opsList 全为 'put' 且段 1 算出的 hashes[] 每个都已存在于 w.defs
      → return ok(w, true, argsHash, [])  // isNoop=true, written=[]，跳过段 2
边界: 含任何非 put（或嵌套 batch）的批仍走段 2
规格: §10.3 dup 短路段 + §10.4 行 780（"batch 子操作全是已存在 put → isNoop"）已落
不变量 14: batch ≤ 2·N+2 上界不破（短路后 ≤ N+2，规格只锁上界不锁做法 ✓）
```

### T4 · 宿主：`experiment/host.ts`（零内核改动）

| # | 现状 | 做什么 |
|---|---|---|
| 1 ✓ | 已改：`loadEntries()` Buffer 切行 | — |
| 2 ✓ | 已改：`coldBoot()` 只 replay，verify 降为 `boot` 深度档 | — |
| 3 | 未做 | 加薄函数 `assemble(mode)`：full = verify+replay 全量；partial = ① verify([],anchor,{worldRev}) 校基础 → ② verify(尾段,anchor) → ③ replay(尾段,基础)；**做完后删 `FR` 文件那个另存 rev 的土办法**（§6 base_only 的宿主实现） |
| 4 | 未做（T3 落地后不需要） | T3 落地前可先套 try/catch 兜底，T3 合并后删 |

### T6 · 规矩 A 生效：pins 单一记录 + schema 门禁 term（宿主侧）

| # | 现状 | 做什么 |
|---|---|---|
| 1 | 已改：`host.ts` add_gen 带 `pins:{src:K_SRC}` | body 里**不重复列**同一个哈希（manifestOf 的 body 应只剩 `{lang}`，src 只在 pins） |
| 2 | 未做 | 写第一份 `schema` def = 一条可执行 term（如 `["g",["pins","src"]]`——缺该项即 walk 抛 missing_path ⇒ refused），宿主在 `add_gen` 前 eval 它做门禁。**M2 归约机的第一个真实用户。** |

评审方的 `stale` 红→绿测试是他们的活——你交付 host 侧的 pins + schema term，不碰测试。

### T8 · 实验：bench 四档新测点（`experiment/bench-scale.ts`）

- 口径修正已完成（X10 绝对语料两档、journal ×N、A 段 warmup+中位数）
- **新测点（按四档各测一档）**：
  - ① 2500 × 20KB 真实尺度源码进 defs（预期全量审计 ≈8s）
  - ② N 万条 200B 载荷 note（T2 落地后；预期 defs **零增长**，不变量 16 的实测）
  - ③④ 1GB 本体进 blob、世界只存哈希（预期内核侧总哈希量降到几 MB）
- 本机 8.4GB 内存、空闲 ~1.0GB → **① 可跑、② 尽力跑（1M 条测比率）、③④ 已有 B/F 段数据**；真数需换机器（≥16GB）。

## 4. 顺序与并行

```
T2（1 行）──┐
T3（2 行）──┴──► T4#3/#4（宿主 assemble）
T5（短路）────► T8（② 档 note 测点依赖 T2）
T6（pins + schema term）── 独立，但须在第一个真实插件之前
```

T2 / T3 / T5 三条互不相干，可一次提交；T4 只依赖 T3 落地（可先套 try/catch 兜底）；T6 不依赖内核改动。

## 5. 实现方判据（你自己跑，不是自评绿）

```
cd packages/kernel
npm run typecheck    # tsc --noEmit 零错误
npm run format:check # prettier --check . 零差异
npm test             # 183 全绿（本轮不增——新测试是评审方的）
```

- T2/T3/T5 改动后 `npm test` 必须 **183 仍全绿**（你不加测试；新增的 6+3+1 由评审方后续补，届时增到 ≥192）。
- T5 短路后，实验复测 `dup/put` 应降到 <10%（`BENCH_DEFS=1000` 跑一轮即可确认）。
- T6 的 stale 红→绿是评审方的验收闸，不是你跑的——你只交付 host 侧的 pins + schema term。

## 6. 不许顺手做

- 加 `truncate` / `compact` / `index` op（加动词，禁止）
- 改 `H` 口径 / `argsHash` 口径 / 链格式 / 任何既有哈希语义
- 把 `H` 做成注入 / 端口 / 执行件
- 把闭包算法做进内核
- 给 `Identity` 加 `class` 或分类标签
- 在 `note` 载荷上定大小上限做成内核常量（那是宿主门禁）
- 把任何绝对 ms / MB·s⁻¹ 写进 `kernel.md` 规范文本
- **碰任何 `*.test.ts` 文件**（那是评审方的领地）

发现新需求时先过 §0 的四向路由判据（`kernel-next-steps.md:13`），再来问要不要动内核。
