# toy-router

单判定实验夹具：把 `router.select` 的候选选择判定写成糖化 term（`terms.src/select.json`），
经工具链编译进 `terms/`，随包入世。执行件保留为「取数 / 出效果」的 stdio 服务（本夹具只保留最小服务壳）。

- `terms.src/select.json`：策略 A——候选顺序即偏好序，取第一个 ∈ aliases 的候选，否则回 primary（须在候选内）。
- `terms.src/select-v2.json`：策略 B——primary 优先，否则第一个 ∈ aliases 的候选。
- 两策略都编译进 `terms/`；实验用后者替换前者的成员内容，验证判定改动只换代数据（进程热生效）。
- `.worldignore` 排除 `terms.src/` 与 `test/`。
