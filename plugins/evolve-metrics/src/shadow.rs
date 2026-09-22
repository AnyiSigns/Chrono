// `shadow`：影子回放（门禁第二道，v1 闭环）。纯计算、零 token、不调任何真实端口。
// 配对口径（v1）：按 `(port, method, args_hash)` 与 #43 `trace.eff_log` 配对回灌结果；
// `host.audit` 读历史 `EffectAudit` 作**补充对照源**（eff_log 缺匹配时按 (port,method) 兜底）。
// 出 `pass` / `fail` / `unverified`，产指标 def 的 put 计划供 #33 写 `verdicts.gate.shadow`（本插件不写链）。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::bag;
use crate::error::ServiceError;
use crate::hash;
use crate::plan;
use crate::port::AuditSource;

/// 期望 eff 点（候选新图应发出的效果）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffKey {
    pub port: String,
    pub method: String,
    pub args_hash: Option<String>,
}

/// 历史 eff 记录（#43 `trace.eff_log` 一步）。
#[derive(Clone, Debug)]
pub struct EffRecord {
    pub port: String,
    pub method: String,
    pub args_hash: Option<String>,
    pub result_hash: Option<String>,
    pub outcome: String,
}

/// 历史审计记录（`EffectAudit` 精简面）。
#[derive(Clone, Debug)]
pub struct AuditRecord {
    pub port: String,
    pub method: String,
    pub outcome: String,
}

/// 三态 + 指标（纯函数）。
pub fn evaluate(
    expected: &[EffKey],
    history: &[EffRecord],
    audit: &[AuditRecord],
) -> (String, Value) {
    let mut index: BTreeMap<(String, String), Vec<&EffRecord>> = BTreeMap::new();
    for record in history {
        index
            .entry((record.port.clone(), record.method.clone()))
            .or_default()
            .push(record);
    }
    let mut audit_index: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for record in audit {
        audit_index
            .entry((record.port.clone(), record.method.clone()))
            .or_default()
            .insert(record.outcome.clone());
    }

    let mut matched = 0usize;
    let mut inconsistent = 0usize;
    let mut unverified = 0usize;
    let mut pairs = Vec::new();
    for key in expected {
        let candidates: Vec<&&EffRecord> = index
            .get(&(key.port.clone(), key.method.clone()))
            .map(|records| {
                records
                    .iter()
                    .filter(|record| match &key.args_hash {
                        Some(hash) => record.args_hash.as_deref() == Some(hash.as_str()),
                        None => true,
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !candidates.is_empty() {
            let result_hashes: BTreeSet<String> = candidates
                .iter()
                .filter_map(|record| record.result_hash.clone())
                .collect();
            if result_hashes.len() > 1 {
                inconsistent += 1;
            } else {
                matched += 1;
            }
            pairs.push(json!({
                "port": key.port,
                "method": key.method,
                "args_hash": key.args_hash,
                "source": "eff_log",
                "result_hashes": result_hashes.into_iter().collect::<Vec<String>>(),
            }));
            continue;
        }
        if audit_index
            .get(&(key.port.clone(), key.method.clone()))
            .map(|outcomes| !outcomes.is_empty())
            .unwrap_or(false)
        {
            matched += 1;
            pairs.push(json!({
                "port": key.port,
                "method": key.method,
                "args_hash": key.args_hash,
                "source": "audit",
            }));
            continue;
        }
        unverified += 1;
        pairs.push(json!({
            "port": key.port,
            "method": key.method,
            "args_hash": key.args_hash,
            "source": null,
        }));
    }

    let status = if inconsistent > 0 {
        "fail"
    } else if unverified > 0 {
        "unverified"
    } else {
        "pass"
    };
    let metric = json!({
        "status": status,
        "expected": expected.len(),
        "matched": matched,
        "inconsistent": inconsistent,
        "unverified": unverified,
        "pairs": pairs,
    });
    (status.to_string(), metric)
}

/// 执行 shadow：推导期望 eff 点 → 取历史配对源 → 纯计算 → 返回指标与 put 计划。
pub fn run(
    bag: &Value,
    _env: &Value,
    audit_source: &dyn AuditSource,
) -> Result<Value, (String, String)> {
    let expected = derive_expected(bag);
    // 期望 eff 点推导不出来（无 graph / contracts / expected_effs）⇒ fail-closed 记 unverified，不读审计。
    let (status, metric) = if expected.is_empty() {
        (
            "unverified".to_string(),
            json!({
                "status": "unverified",
                "expected": 0,
                "matched": 0,
                "inconsistent": 0,
                "unverified": 0,
                "reason": "no_expected_effs",
                "pairs": [],
            }),
        )
    } else {
        let history = collect_history(bag);
        let audit = collect_audit(bag, audit_source);
        evaluate(&expected, &history, &audit)
    };

    let metric_def = {
        let mut object = metric.as_object().cloned().unwrap_or_default();
        object.insert("kind".to_string(), json!("shadow_metric"));
        object.insert(
            "graph".to_string(),
            bag.get("graph").cloned().unwrap_or(Value::Null),
        );
        Value::Object(object)
    };
    // def 键口径 = 内核 `H({body})`（64hex sha256），与投影 `{"def":hash}` 标记对齐，
    // 使 #33 写入 `verdicts.gate.shadow={def:metric_id}` 可被投影解析到同批 put 的 def。
    let metric_id = hash::kernel_hash(&json!({ "body": metric_def }));
    let directives = vec![plan::batch_directive(vec![plan::put_op(metric_def.clone())])];

    let mut result = Map::new();
    result.insert("status".to_string(), json!(status));
    result.insert("metric".to_string(), metric);
    result.insert("metric_id".to_string(), json!(metric_id));
    result.insert("$directives".to_string(), Value::Array(directives));
    Ok(Value::Object(result))
}

/// 期望 eff 点：显式 `expected_effs` 优先；否则由 graph 节点 + contracts 派发目标推导。
fn derive_expected(bag: &Value) -> Vec<EffKey> {
    if let Some(items) = bag.get("expected_effs").and_then(Value::as_array) {
        return items.iter().filter_map(eff_key_of).collect();
    }
    let graph = bag::graph(bag);
    let contracts = bag.get("contracts").cloned().unwrap_or(Value::Null);
    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut keys: BTreeSet<(String, String)> = BTreeSet::new();
    for node in &nodes {
        let (contract_id, entry) = node_target(node);
        if let Some(entry) = entry {
            if let Some(key) = eff_key_of(&entry) {
                keys.insert((key.port, key.method));
                continue;
            }
        }
        if contract_id.is_empty() {
            continue;
        }
        if let Some(contract) = contracts.get(&contract_id) {
            if let Some(entry) = contract.get("entry") {
                if let Some(key) = eff_key_of(entry) {
                    keys.insert((key.port, key.method));
                    continue;
                }
            }
            if let Some(effects) = contract.get("effects") {
                let ports: Vec<String> = effects
                    .get("ports")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                let methods: Vec<String> = effects
                    .get("methods")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                for port in &ports {
                    if methods.is_empty() {
                        keys.insert((port.clone(), String::new()));
                    } else {
                        for method in &methods {
                            keys.insert((port.clone(), method.clone()));
                        }
                    }
                }
            }
        }
    }
    keys.into_iter()
        .map(|(port, method)| EffKey {
            port,
            method,
            args_hash: None,
        })
        .collect()
}

fn node_target(node: &Value) -> (String, Option<Value>) {
    if let Some(contract_id) = node.as_str() {
        return (contract_id.to_string(), None);
    }
    let contract_id = node
        .get("contract_id")
        .and_then(Value::as_str)
        .or_else(|| node.get("id").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    (contract_id, node.get("entry").cloned())
}

fn eff_key_of(value: &Value) -> Option<EffKey> {
    let port = value
        .get("port")
        .or_else(|| value.get("cap"))
        .and_then(Value::as_str)?;
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    Some(EffKey {
        port: port.to_string(),
        method: method.to_string(),
        args_hash: value.get("args_hash").and_then(Value::as_str).map(str::to_string),
    })
}

/// 历史 eff：显式 `eff_log` + 轨迹窗口各步 `eff_log`。
fn collect_history(bag: &Value) -> Vec<EffRecord> {
    let mut records = Vec::new();
    if let Some(items) = bag.get("eff_log").and_then(Value::as_array) {
        records.extend(items.iter().filter_map(eff_record_of));
    }
    for trace in bag::trace_entries(bag) {
        for step in trace.steps() {
            if let Some(items) = step.get("eff_log").and_then(Value::as_array) {
                records.extend(items.iter().filter_map(eff_record_of));
            }
        }
    }
    records
}

fn eff_record_of(value: &Value) -> Option<EffRecord> {
    let port = value.get("port").and_then(Value::as_str)?.to_string();
    Some(EffRecord {
        port,
        method: value.get("method").and_then(Value::as_str).unwrap_or("").to_string(),
        args_hash: value.get("args_hash").and_then(Value::as_str).map(str::to_string),
        result_hash: value.get("result_hash").and_then(Value::as_str).map(str::to_string),
        outcome: value.get("outcome").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

/// 历史审计：bag 直接给 `audit` 优先；否则经 `host.audit` 反向调用读（补充对照源）。
fn collect_audit(bag: &Value, audit_source: &dyn AuditSource) -> Vec<AuditRecord> {
    let records: Vec<Value> = if let Some(items) = bag.get("audit").and_then(Value::as_array) {
        items.clone()
    } else {
        let filter = bag.get("audit_filter").cloned().unwrap_or(Value::Null);
        let limit = bag.get("audit_limit").and_then(Value::as_u64);
        match audit_source.audit(&filter, limit) {
            Ok(value) => value
                .get("records")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            // 审计读失败作数据：不阻断 shadow，退化为仅用 eff_log。
            Err(ServiceError { .. }) => Vec::new(),
        }
    };
    records.iter().filter_map(audit_record_of).collect()
}

fn audit_record_of(value: &Value) -> Option<AuditRecord> {
    let body = value.get("body").unwrap_or(value);
    let port = body.get("port").and_then(Value::as_str)?.to_string();
    Some(AuditRecord {
        port,
        method: body.get("method").and_then(Value::as_str).unwrap_or("").to_string(),
        outcome: body.get("outcome").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(port: &str, method: &str, args: &str) -> EffKey {
        EffKey {
            port: port.to_string(),
            method: method.to_string(),
            args_hash: Some(args.to_string()),
        }
    }

    fn record(port: &str, method: &str, args: &str, result: &str) -> EffRecord {
        EffRecord {
            port: port.to_string(),
            method: method.to_string(),
            args_hash: Some(args.to_string()),
            result_hash: Some(result.to_string()),
            outcome: "ok".to_string(),
        }
    }

    #[test]
    fn pass_when_all_matched_and_consistent() {
        let expected = vec![key("model", "chat", "a1")];
        let history = vec![record("model", "chat", "a1", "r1")];
        let (status, metric) = evaluate(&expected, &history, &[]);
        assert_eq!(status, "pass");
        assert_eq!(metric["matched"], 1);
    }

    #[test]
    fn fail_when_results_inconsistent() {
        let expected = vec![key("model", "chat", "a1")];
        let history = vec![
            record("model", "chat", "a1", "r1"),
            record("model", "chat", "a1", "r2"),
        ];
        let (status, metric) = evaluate(&expected, &history, &[]);
        assert_eq!(status, "fail");
        assert_eq!(metric["inconsistent"], 1);
    }

    #[test]
    fn unverified_when_no_match() {
        let expected = vec![key("model", "chat", "a1")];
        let (status, metric) = evaluate(&expected, &[], &[]);
        assert_eq!(status, "unverified");
        assert_eq!(metric["unverified"], 1);
    }

    #[test]
    fn audit_supplements_missing_eff_log() {
        let expected = vec![key("model", "chat", "a1")];
        let audit = vec![AuditRecord {
            port: "model".to_string(),
            method: "chat".to_string(),
            outcome: "ok".to_string(),
        }];
        let (status, metric) = evaluate(&expected, &[], &audit);
        assert_eq!(status, "pass");
        assert_eq!(metric["pairs"][0]["source"], "audit");
    }

    #[test]
    fn derive_expected_from_graph_and_contracts() {
        let bag = json!({
            "graph": {"nodes": ["agent.step", "tool.dispatch"]},
            "contracts": {
                "agent.step": {"entry": {"cap": "model", "method": "chat"}},
                "tool.dispatch": {"effects": {"ports": ["tools"], "methods": ["dispatch"]}}
            }
        });
        let expected = derive_expected(&bag);
        assert_eq!(expected.len(), 2);
        assert!(expected.iter().any(|key| key.port == "model" && key.method == "chat"));
        assert!(expected.iter().any(|key| key.port == "tools" && key.method == "dispatch"));
    }

    #[test]
    fn explicit_expected_effs_take_precedence() {
        let bag = json!({"expected_effs": [{"port": "p", "method": "m", "args_hash": "h"}]});
        let expected = derive_expected(&bag);
        assert_eq!(expected, vec![key("p", "m", "h")]);
    }

    #[test]
    fn run_without_graph_is_unverified_and_emits_plan() {
        use crate::port::StaticAudit;
        let value = run(&json!({"audit": []}), &json!({}), &StaticAudit::new(Vec::new())).unwrap();
        assert_eq!(value["status"], "unverified");
        assert_eq!(value["metric"]["reason"], "no_expected_effs");
        assert!(!value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn metric_id_is_kernel_def_hash() {
        use crate::port::StaticAudit;
        let bag = json!({
            "expected_effs": [{"port": "model", "method": "chat"}],
            "audit": []
        });
        let value = run(&bag, &json!({}), &StaticAudit::new(Vec::new())).unwrap();
        let metric_id = value["metric_id"].as_str().unwrap();
        // 64hex 小写：投影 markerHash 只认此形状。
        assert_eq!(metric_id.len(), 64);
        assert!(metric_id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        // metric_id == H({body: metric_def}) == 同批 put 的 def 键（非孤儿）。
        let ops = value["$directives"][0]["request"]["args"]["ops"]
            .as_array()
            .unwrap();
        assert_eq!(ops[0]["op"], "put");
        let body = ops[0]["args"]["body"].clone();
        assert_eq!(metric_id, hash::kernel_hash(&json!({ "body": body })));
    }

    #[test]
    fn run_passes_with_expected_and_history() {
        use crate::port::StaticAudit;
        let bag = json!({
            "expected_effs": [{"port": "model", "method": "chat", "args_hash": "a1"}],
            "eff_log": [{"port": "model", "method": "chat", "args_hash": "a1",
                         "result_hash": "r1", "outcome": "ok"}],
            "audit": []
        });
        let value = run(&bag, &json!({}), &StaticAudit::new(Vec::new())).unwrap();
        assert_eq!(value["status"], "pass");
    }
}
