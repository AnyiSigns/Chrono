# secrets-vault（测试夹具）

密钥后端扩展点 `secrets-backend` 的测试夹具：`implements:["secrets-backend"]`，`kinds` 自述 `["vault"]`。

用于证明「新增一个密钥后端 = 新插件自注册，`secrets` 与消费方零改动」：
`secrets` 按宿主注入的世界成员表逐个 `kinds` 定位 kind，再反调成员 `read`。
本夹具只回固定引用名与明文，无真实保险库，不是生产后端。
