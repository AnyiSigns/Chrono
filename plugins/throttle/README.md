# throttle（限流与退避决策）

网络链的限流 / 退避**决策提供方**：每 provider 令牌桶状态 + 429 冷却 + 指数退避 / 抖动 /
`Retry-After` 调度。重试循环本身住在消费方（`model-protocol`，依赖流 reset 回调），
本服务只回答「要不要等、等多久、冷却多久」。

- 能力类：`throttle`；方法：`policy` / `acquire` / `plan` / `penalize`。
- `pins`：无（`{}`）；不联网、不读投影、不写世界、无反向调用。
- 时间：不自取时钟，`now` 由调用方传逻辑时钟（毫秒）。
- 状态档：`recomputable`。令牌桶状态落本插件 ③ 目录 `rate-limit.json`；
  目录缺失 / 不可写时安全降级为进程内存，任何读写失败都可重算。

## 方法

### `policy({override?})`

合并本 schema 的 `resilience` 缺省与调用方覆盖，回归一后的 `RetryPolicy`：
`{max_retries, backoff_ms, backoff_max_ms, jitter, request_timeout_ms, connect_timeout_ms, token_bucket, models_dev_url}`。

### `acquire({provider, now, policy?})`

按 `policy.token_bucket` 补充令牌后取一个；回 `{wait_ms}`。`>=1` 令牌扣一后 `wait_ms=0`；
否则回补足一个令牌所需毫秒；429 冷却期内回剩余冷却毫秒。

### `plan({attempt, retry_after_ms?, policy?})`

指数退避 `min(backoff_ms * 2^attempt, backoff_max_ms)`，`retry_after_ms` 取下限，
`jitter=true` 时乘 `[0.5,1]`；回 `{delay_ms}`。抖动只影响时延、不影响世界内容。

### `penalize({provider, now, retry_after_ms?, policy?})`

置该 provider 冷却到 `now + retry_after_ms` 并清空令牌（429 惩罚）。

## 运行

```sh
npm test                 # node --test
```

## `.worldignore`

排除 `test/`；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
