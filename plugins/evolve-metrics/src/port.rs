// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）：门面经此把四方法委派给提供方。
// 通道编解码 / 登记结算走 plugin-sdk 的 `PortLink`；本模块只留领域适配。
// 反向调用失败作数据（ServiceError），不抛错、不断通道；单测用可注入的假实现替换真实通道。

use std::sync::Arc;

use serde_json::Value;

use plugin_sdk::PortLink;

use crate::error::ServiceError;

/// 提供方调用面：把方法转交到目标能力类（提供方身份名 = 能力类名）。
pub trait Providers: Send + Sync {
    fn call(&self, capability: &str, method: &str, args: &Value) -> Result<Value, ServiceError>;
}

/// 经协议出口发 `port.call` 的反向调用实现。
pub struct RemoteProviders {
    link: Arc<PortLink>,
}

impl RemoteProviders {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl Providers for RemoteProviders {
    fn call(&self, capability: &str, method: &str, args: &Value) -> Result<Value, ServiceError> {
        self.link
            .call(capability, method, args.clone())
            .map_err(|error| ServiceError::new(&error.code, error.message))
    }
}
