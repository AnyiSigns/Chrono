// 台账提供方消费面（反向调用 `evolve-ledger.*`，docs/protocol.md §2.4）。
// 链窗口读取 / 哈希（内核口径 def 键）/ 写计划构造全在台账提供方；本插件只按线形消费。
// 失败作数据（ServiceError），不抛未捕获错误、不断通道；单测用可注入的假实现替换真实通道。

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::PortLink;

use crate::chain;
use crate::error::ServiceError;

/// 链窗口（`evolve-ledger.read-chain` 回包归一）。
#[derive(Clone, Debug, Default)]
pub struct ChainWindows {
    pub trace: Vec<chain::TraceRef>,
    pub evidence: Vec<chain::TraceRef>,
    pub body: Option<Value>,
    pub base: Option<u64>,
    pub refs: Value,
    pub refusal_codes: BTreeMap<String, String>,
}

/// 台账提供方抽象：生产环境是反向调用，单测注入假实现。
pub trait Ledger: Send + Sync {
    fn read_chain(&self, bag: &Value) -> Result<ChainWindows, ServiceError>;
    fn thresholds(&self, bag: &Value) -> Result<Value, ServiceError>;
    fn hashes(&self, values: &[Value], mode: &str) -> Result<Vec<String>, ServiceError>;
    fn patch_plan(&self, request: &Value) -> Result<Value, ServiceError>;
}

/// `evolve-ledger.*` 的反向调用后端。
pub struct RemoteLedger {
    link: Arc<PortLink>,
}

impl RemoteLedger {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }

    fn call(&self, method: &str, args: Value) -> Result<Value, ServiceError> {
        self.link
            .call("evolve-ledger", method, args)
            .map_err(|error| ServiceError::new(&error.code, error.message))
    }
}

impl Ledger for RemoteLedger {
    fn read_chain(&self, bag: &Value) -> Result<ChainWindows, ServiceError> {
        let value = self.call("read-chain", json!({ "bag": bag }))?;
        Ok(ChainWindows {
            trace: chain::entries(&value["trace"]),
            evidence: chain::entries(&value["evidence"]),
            body: value.get("body").cloned().filter(|item| !item.is_null()),
            base: value.get("base").and_then(Value::as_u64),
            refs: value.get("refs").cloned().unwrap_or(Value::Null),
            refusal_codes: BTreeMap::new(),
        })
    }

    fn thresholds(&self, bag: &Value) -> Result<Value, ServiceError> {
        let value = self.call("thresholds", json!({ "bag": bag }))?;
        Ok(value.get("values").cloned().unwrap_or_else(|| json!({})))
    }

    fn hashes(&self, values: &[Value], mode: &str) -> Result<Vec<String>, ServiceError> {
        let value = self.call("hash", json!({ "values": values, "mode": mode }))?;
        Ok(value
            .get("hashes")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }

    fn patch_plan(&self, request: &Value) -> Result<Value, ServiceError> {
        self.call("patch-plan", request.clone())
    }
}

/// 从 `patch_plan` 回包取 `$directives` 数组。
pub fn directives_of(plan: &Value) -> Vec<Value> {
    plan.get("$directives")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
