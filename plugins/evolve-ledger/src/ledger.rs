// 台账提供方消费面：链窗口读取 / 写计划构造 / 阈值解析 / 哈希全部在本二进制内就地调用
// `methods`，不再经反向 `port.call`；本模块只把线形归一成领域视图，供
// aggregate / sweep / shadow / record 消费。失败作数据（ServiceError），不抛未捕获错误；
// 单测用可注入的假实现替换真实实现。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::chain;
use crate::error::ServiceError;
use crate::methods;

/// 链窗口与写计划所需的元数据（台账 `read-chain` 回包归一）。
#[derive(Clone, Debug, Default)]
pub struct ChainWindows {
    pub trace: Vec<chain::TraceRef>,
    pub evidence: Vec<chain::TraceRef>,
    pub body: Option<Value>,
    pub base: Option<u64>,
    pub refs: Value,
    pub refusal_codes: BTreeMap<String, String>,
}

/// 台账提供方抽象：生产环境就地调用本二进制方法，单测注入假实现。
pub trait Ledger: Send + Sync {
    fn read_chain(&self, bag: &Value) -> Result<ChainWindows, ServiceError>;
    fn thresholds(&self, bag: &Value) -> Result<Value, ServiceError>;
    /// 批量哈希；`mode` 见台账契约（content / canonical / kernel / fnv）。
    fn hashes(&self, values: &[Value], mode: &str) -> Result<Vec<String>, ServiceError>;
    /// 构造台账写计划；回包含 `$directives`。
    fn patch_plan(&self, request: &Value) -> Result<Value, ServiceError>;
}

/// 进程内台账：直接调本二进制的 `methods`，线形与协议一致但不经 `port.call`。
pub struct LocalLedger;

impl LocalLedger {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalLedger {
    fn default() -> Self {
        Self::new()
    }
}

impl Ledger for LocalLedger {
    fn read_chain(&self, bag: &Value) -> Result<ChainWindows, ServiceError> {
        let value = methods::read_chain(&json!({ "bag": bag }));
        Ok(ChainWindows {
            trace: chain::entries(&value["trace"]),
            evidence: chain::entries(&value["evidence"]),
            body: value.get("body").cloned().filter(|item| !item.is_null()),
            base: value.get("base").and_then(Value::as_u64),
            refs: value.get("refs").cloned().unwrap_or(Value::Null),
            refusal_codes: refusal_codes_of(&value["refusal_codes"]),
        })
    }

    fn thresholds(&self, bag: &Value) -> Result<Value, ServiceError> {
        let value = methods::thresholds(&json!({ "bag": bag }));
        Ok(value.get("values").cloned().unwrap_or_else(|| json!({})))
    }

    fn hashes(&self, values: &[Value], mode: &str) -> Result<Vec<String>, ServiceError> {
        let value = methods::hash_method(&json!({ "values": values, "mode": mode }))
            .map_err(|(code, message)| ServiceError::new(&code, message))?;
        Ok(value
            .get("hashes")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }

    fn patch_plan(&self, request: &Value) -> Result<Value, ServiceError> {
        methods::patch_plan(request).map_err(|(code, message)| ServiceError::new(&code, message))
    }
}

fn refusal_codes_of(value: &Value) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(map) = value.as_object() {
        for (code, attribution) in map {
            if let Some(text) = attribution.as_str() {
                out.insert(code.clone(), text.to_string());
            }
        }
    }
    out
}

/// 从 `patch_plan` 回包取 `$directives` 数组。
pub fn directives_of(plan: &Value) -> Vec<Value> {
    plan.get("$directives")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_ledger_reads_chain_and_thresholds() {
        let ledger = LocalLedger::new();
        let bag = json!({
            "trace_entries": [{"kind": "trace", "def": "t0", "run": "r1", "outcome": "done"}],
            "thresholds": {"fold_k": 4}
        });
        let windows = ledger.read_chain(&bag).unwrap();
        assert_eq!(windows.trace.len(), 1);
        assert_eq!(windows.trace[0].run(), "r1");
        assert_eq!(ledger.thresholds(&bag).unwrap()["fold_k"], 4.0);
    }

    #[test]
    fn local_ledger_hashes_and_patch_plan() {
        let ledger = LocalLedger::new();
        let hashes = ledger.hashes(&[json!("hello")], "fnv").unwrap();
        assert_eq!(hashes.len(), 1);
        let plan = ledger
            .patch_plan(&json!({"puts": [{"kind": "shadow_metric"}]}))
            .unwrap();
        assert_eq!(directives_of(&plan).len(), 1);
    }
}
