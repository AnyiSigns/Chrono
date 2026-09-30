// 门面向提供方的反向调用通道：`sandbox` 退化为薄门面，把算法委派给 `sandbox-policy` /
// `sandbox-exec` / `sandbox-fs`。反向调用自带 `call_id`（宿主据此配对正向帧 env），
// 反向等待上限抬到覆盖 `exec` 的最长方法级超时（130000 + 余量）。

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use plugin_sdk::{PortLink, ServiceError, SharedWriter};

/// 反向等待上限：覆盖 `sandbox-exec.exec` 的 130000，避免门面先于提供方超时。
const PORT_TIMEOUT_MS: u64 = 140_000;

/// 提供方反向调用句柄。
pub struct Providers {
    link: Arc<PortLink>,
}

impl Providers {
    pub fn new(writer: SharedWriter) -> Self {
        let link = PortLink::with_timeout(writer, "sandbox", Duration::from_millis(PORT_TIMEOUT_MS));
        Self { link: Arc::new(link) }
    }

    /// 调一个提供方能力方法；错误作数据（`ServiceError`）。
    pub fn call(&self, port: &str, method: &str, args: Value) -> Result<Value, ServiceError> {
        self.link.call(port, method, args)
    }

    /// 结算宿主回的 `port.result` / `port.error` 帧；返回是否已消费。
    pub fn settle(&self, frame: &Value) -> bool {
        self.link.settle(frame)
    }
}
