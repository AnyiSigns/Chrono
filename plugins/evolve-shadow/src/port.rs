// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）与依赖抽象。
// 通道编解码 / 登记结算走 plugin-sdk 的 `PortLink`；本模块只留领域适配：
// 本插件 pin = 保留身份 `host`；`shadow` 经 `host.audit` 读历史 `EffectAudit` 作补充对照源。
// 反向调用失败作数据、不抛错、不断通道；单测用可注入的假实现替换真实通道。

use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::PortLink;

use crate::error::ServiceError;

/// 历史审计读面（`host.audit`）；`shadow` 作补充对照源，缺省可从 bag 直接给记录。
pub trait AuditSource: Send + Sync {
    fn audit(&self, filter: &Value, limit: Option<u64>) -> Result<Value, ServiceError>;
}

/// 经反向调用 `host.audit {filter?,limit?}` 读历史 `EffectAudit`。
pub struct RemoteAudit {
    link: Arc<PortLink>,
}

impl RemoteAudit {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl AuditSource for RemoteAudit {
    fn audit(&self, filter: &Value, limit: Option<u64>) -> Result<Value, ServiceError> {
        let mut args = json!({});
        if !filter.is_null() {
            args["filter"] = filter.clone();
        }
        if let Some(limit) = limit {
            args["limit"] = json!(limit);
        }
        self.link
            .call("host", "audit", args)
            .map_err(|error| ServiceError::new(&error.code, error.message))
    }
}

/// 静态审计源：集成测试 / 无 host 通道时注入固定记录。
pub struct StaticAudit {
    pub records: Value,
}

impl StaticAudit {
    pub fn new(records: Vec<Value>) -> Self {
        Self {
            records: Value::Array(records),
        }
    }
}

impl AuditSource for StaticAudit {
    fn audit(&self, _filter: &Value, _limit: Option<u64>) -> Result<Value, ServiceError> {
        Ok(json!({ "records": self.records, "truncated": false }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_audit_returns_records() {
        let audit = StaticAudit::new(vec![json!({"port": "model"})]);
        let value = audit.audit(&Value::Null, None).unwrap();
        assert_eq!(value["records"][0]["port"], "model");
        assert_eq!(value["truncated"], false);
    }
}
