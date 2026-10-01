// `sweep`：读轨迹窗口 + evidence 链 + verdicts/proposals 引用集 → 产清理计划
// （写新 evolution body 索引、不含过期条目）。保留回合数读 thresholds；
// **不动被 verdict / proposal 引用的轨迹与证据**（否则 verdict → proposal → evidence → trace 溯源链断）。
// 清理只动索引，def 仍在链上（① 档既定代价，不是删除）。纯计算、同输入同输出。
// 链窗口 / 阈值 / 写计划构造经 `evolve-ledger` 反向调用。

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::chain::TraceRef;
use crate::error::ServiceError;
use crate::ledger::{directives_of, Ledger};
use crate::thresholds::Thresholds;

/// 执行 sweep。
pub fn run(bag: &Value, env: &Value, ledger: &dyn Ledger) -> Result<Value, (String, String)> {
    let env = effective_env(bag, env);
    let windows = ledger.read_chain(bag).map_err(as_tuple)?;
    let traces = windows.trace.clone();
    let evidence = windows.evidence.clone();
    let thresholds = Thresholds::from_values(&ledger.thresholds(bag).map_err(as_tuple)?);
    let now = now_of(bag, &env);
    let retention = thresholds.count("trace_retention_rounds", 50);
    let evidence_retention = thresholds.count("evidence_retention_rounds", 50);
    let referenced = referenced_trace_defs(bag, &windows.refs);
    let referenced_evidence = referenced_evidence_ids(bag);

    // 保留 = 最新 N 条 ∪ 被引用者（无论多旧）。
    let (retained, swept, referenced_kept) =
        window(&traces, retention, &referenced, |trace| trace.def.clone());
    let (retained_evidence, evidence_swept, evidence_referenced_kept) =
        window(&evidence, evidence_retention, &referenced_evidence, |entry| {
            let id = entry.id();
            if id.is_empty() {
                None
            } else {
                Some(id)
            }
        });

    let body = windows.body.clone();
    let mut directives = Vec::new();
    if (!traces.is_empty() || !evidence.is_empty()) && body.is_some() {
        let mut replace = Map::new();
        if !traces.is_empty() {
            replace.insert("trace".to_string(), index_of(&retained, swept, &now));
        }
        if !evidence.is_empty() {
            replace.insert(
                "evidence".to_string(),
                index_of(&retained_evidence, evidence_swept, &now),
            );
        }
        let request = json!({
            "gen_id": "evolution",
            "body": body,
            "base": windows.base,
            "replace": replace,
        });
        let plan = ledger.patch_plan(&request).map_err(as_tuple)?;
        directives = directives_of(&plan);
    }

    let mut result = Map::new();
    result.insert("swept".to_string(), json!(swept));
    result.insert("retained".to_string(), json!(retained.len()));
    result.insert("referenced".to_string(), json!(referenced_kept));
    result.insert("evidence_swept".to_string(), json!(evidence_swept));
    result.insert("evidence_retained".to_string(), json!(retained_evidence.len()));
    result.insert("evidence_referenced".to_string(), json!(evidence_referenced_kept));
    result.insert("$directives".to_string(), Value::Array(directives));
    Ok(Value::Object(result))
}

/// 窗口：保留最新 `retention` 条 ∪ 被引用者；返回（保留项, 淘汰数, 被引用强留数）。
fn window<'a>(
    entries: &'a [TraceRef],
    retention: usize,
    referenced: &BTreeSet<String>,
    key: impl Fn(&TraceRef) -> Option<String>,
) -> (Vec<&'a TraceRef>, usize, usize) {
    let keep_from = entries.len().saturating_sub(retention);
    let is_referenced = |entry: &TraceRef| {
        key(entry)
            .map(|value| referenced.contains(&value))
            .unwrap_or(false)
    };
    let mut retained = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if index >= keep_from || is_referenced(entry) {
            retained.push(entry);
        }
    }
    let swept = entries.len() - retained.len();
    let referenced_kept = retained.iter().filter(|entry| is_referenced(entry)).count();
    (retained, swept, referenced_kept)
}

/// 新索引体：链头 + 保留显式列表 + 淘汰计数（`retained` 是权威边界，防窗口不缩）。
fn index_of(retained: &[&TraceRef], swept: usize, now: &Value) -> Value {
    let tail = retained
        .last()
        .and_then(|entry| entry.def.clone())
        .map(|hash| json!({ "def": hash }))
        .unwrap_or(Value::Null);
    let list: Vec<Value> = retained
        .iter()
        .filter_map(|entry| entry.def.clone())
        .map(|hash| json!({ "def": hash }))
        .collect();
    json!({
        "tail": tail,
        "count": retained.len(),
        "retained": list,
        "dropped": swept,
        "swept_at": now,
    })
}

/// 被 verdict / proposal 引用的 evidence 逻辑 id 集（`evidence_ids`）。
fn referenced_evidence_ids(bag: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    if let Some(items) = bag.get("referenced_evidence_ids").and_then(Value::as_array) {
        for item in items.iter().filter_map(Value::as_str) {
            ids.insert(item.to_string());
        }
    }
    for key in ["proposals", "verdicts"] {
        if let Some(items) = bag.get(key).and_then(Value::as_array) {
            for entry in items {
                if let Some(list) = entry.get("evidence_ids").and_then(Value::as_array) {
                    for id in list.iter().filter_map(Value::as_str) {
                        ids.insert(id.to_string());
                    }
                }
            }
        }
    }
    ids
}

/// 被 verdict 引用的轨迹 def 集：显式集 ∪ verdict → evidence_ids → evidence.traces[].def。
fn referenced_trace_defs(bag: &Value, refs: &Value) -> BTreeSet<String> {
    let mut referenced = BTreeSet::new();
    if let Some(items) = bag.get("referenced_trace_defs").and_then(Value::as_array) {
        for item in items {
            if let Some(hash) = item.as_str() {
                referenced.insert(hash.to_string());
            }
        }
    }

    let mut entries: Vec<Value> = Vec::new();
    if let Some(map) = refs.as_object() {
        entries.extend(map.values().cloned());
    }
    for key in ["evidence", "verdicts"] {
        if let Some(items) = bag.get(key).and_then(Value::as_array) {
            entries.extend(items.iter().cloned());
        }
    }

    let mut traces_by_evidence: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for entry in &entries {
        if entry.get("kind").and_then(Value::as_str) != Some("evidence") {
            continue;
        }
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let defs: Vec<String> = entry
            .get("traces")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("def").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        traces_by_evidence.entry(id.to_string()).or_default().extend(defs);
    }
    for entry in &entries {
        if entry.get("kind").and_then(Value::as_str) != Some("verdict") {
            continue;
        }
        if let Some(ids) = entry.get("evidence_ids").and_then(Value::as_array) {
            for id in ids.iter().filter_map(Value::as_str) {
                if let Some(defs) = traces_by_evidence.get(id) {
                    referenced.extend(defs.iter().cloned());
                }
            }
        }
    }
    referenced
}

/// 入参中可携带的调用帧 env（宿主直接填帧 env；`bag.__env` 兼容旧门面转交形状）。
fn effective_env(args: &Value, env: &Value) -> Value {
    if env.is_object() {
        env.clone()
    } else {
        args.get("__env").cloned().unwrap_or(Value::Null)
    }
}

fn now_of(bag: &Value, env: &Value) -> Value {
    if let Some(now) = bag.get("now") {
        if !now.is_null() {
            return now.clone();
        }
    }
    env.get("now").cloned().unwrap_or(Value::Null)
}

fn as_tuple(error: ServiceError) -> (String, String) {
    (error.code, error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ChainWindows;
    use std::sync::Mutex;

    struct TestLedger {
        windows: ChainWindows,
        thresholds: Value,
        plan: Value,
        last_request: Mutex<Value>,
    }

    impl TestLedger {
        fn new(windows: ChainWindows) -> Self {
            Self {
                windows,
                thresholds: json!({}),
                plan: json!({"$directives": [{"kind": "write"}]}),
                last_request: Mutex::new(Value::Null),
            }
        }
        fn last_request(&self) -> Value {
            self.last_request.lock().unwrap().clone()
        }
    }

    impl Ledger for TestLedger {
        fn read_chain(&self, _bag: &Value) -> Result<ChainWindows, ServiceError> {
            Ok(self.windows.clone())
        }
        fn thresholds(&self, _bag: &Value) -> Result<Value, ServiceError> {
            Ok(self.thresholds.clone())
        }
        fn hashes(&self, _values: &[Value], _mode: &str) -> Result<Vec<String>, ServiceError> {
            Ok(Vec::new())
        }
        fn patch_plan(&self, request: &Value) -> Result<Value, ServiceError> {
            *self.last_request.lock().unwrap() = request.clone();
            Ok(self.plan.clone())
        }
    }

    fn trace(run: &str, def: &str) -> TraceRef {
        TraceRef {
            def: Some(def.to_string()),
            body: json!({"kind": "trace", "run": run, "workspace_id": "w1", "outcome": "done"}),
        }
    }

    fn body() -> Value {
        json!({
            "version": 1,
            "trace": {"tail": {"def": "t2"}, "count": 3},
            "evidence": {"tail": null, "count": 1},
            "proposals": {"tail": null, "count": 0},
            "verdicts": {"tail": {"def": "vd-1"}, "count": 1}
        })
    }

    #[test]
    fn referenced_defs_from_verdict_chain() {
        let bag = json!({
            "evidence": [{"kind": "evidence", "id": "ev-1", "traces": [{"def": "t-old"}]}],
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-1"]}]
        });
        let referenced = referenced_trace_defs(&bag, &Value::Null);
        assert!(referenced.contains("t-old"));
    }

    #[test]
    fn referenced_evidence_ids_from_proposals_and_verdicts() {
        let bag = json!({
            "proposals": [{"kind": "proposal", "id": "pr-1", "evidence_ids": ["ev-1"]}],
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-2"]}]
        });
        let ids = referenced_evidence_ids(&bag);
        assert!(ids.contains("ev-1"));
        assert!(ids.contains("ev-2"));
    }

    #[test]
    fn sweep_keeps_referenced_traces_and_drops_expired() {
        let mut ledger = TestLedger::new(ChainWindows {
            trace: vec![trace("old", "t0"), trace("mid", "t1"), trace("new", "t2")],
            body: Some(body()),
            ..ChainWindows::default()
        });
        ledger.thresholds = json!({"trace_retention_rounds": 1});
        let bag = json!({
            "evidence": [{"kind": "evidence", "id": "ev-1", "traces": [{"def": "t0"}]}],
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-1"]}]
        });
        let value = run(&bag, &json!({"now": 9}), &ledger).unwrap();
        assert_eq!(value["swept"], 1);
        assert_eq!(value["retained"], 2);
        assert_eq!(value["referenced"], 1);
        let request = ledger.last_request();
        let retained = request["replace"]["trace"]["retained"].as_array().unwrap();
        // 被 verdict 引用的旧轨迹 t0 强留，最新 t2 保留，过期 t1 从索引移除。
        assert_eq!(retained.len(), 2);
        assert!(retained.contains(&json!({"def": "t0"})));
        assert!(retained.contains(&json!({"def": "t2"})));
        assert_eq!(request["replace"]["trace"]["dropped"], 1);
    }

    #[test]
    fn sweep_windows_evidence_chain_keeping_referenced() {
        let mut ledger = TestLedger::new(ChainWindows {
            evidence: vec![
                TraceRef { def: Some("e0".to_string()), body: json!({"kind": "evidence", "id": "ev-0"}) },
                TraceRef { def: Some("e1".to_string()), body: json!({"kind": "evidence", "id": "ev-1"}) },
                TraceRef { def: Some("e2".to_string()), body: json!({"kind": "evidence", "id": "ev-2"}) },
            ],
            body: Some(json!({
                "version": 1,
                "trace": {"tail": null, "count": 0},
                "evidence": {"tail": null, "count": 3},
                "proposals": {"tail": null, "count": 0},
                "verdicts": {"tail": null, "count": 0}
            })),
            ..ChainWindows::default()
        });
        ledger.thresholds = json!({"evidence_retention_rounds": 1});
        let bag = json!({
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-0"]}]
        });
        let value = run(&bag, &json!({"now": 5}), &ledger).unwrap();
        assert_eq!(value["evidence_swept"], 1);
        assert_eq!(value["evidence_retained"], 2);
        assert_eq!(value["evidence_referenced"], 1);
        let request = ledger.last_request();
        let retained = request["replace"]["evidence"]["retained"].as_array().unwrap();
        assert!(retained.contains(&json!({"def": "e0"})));
        assert!(retained.contains(&json!({"def": "e2"})));
    }

    #[test]
    fn sweep_without_traces_writes_nothing() {
        let ledger = TestLedger::new(ChainWindows {
            body: Some(body()),
            ..ChainWindows::default()
        });
        let value = run(&json!({}), &json!({}), &ledger).unwrap();
        assert_eq!(value["swept"], 0);
        assert!(value["$directives"].as_array().unwrap().is_empty());
        assert_eq!(ledger.last_request(), Value::Null);
    }

    #[test]
    fn sweep_patch_generation_carries_bag_base() {
        let mut ledger = TestLedger::new(ChainWindows {
            trace: vec![trace("old", "t0"), trace("new", "t1")],
            body: Some(body()),
            base: Some(4),
            ..ChainWindows::default()
        });
        ledger.thresholds = json!({"trace_retention_rounds": 1});
        let value = run(&json!({}), &json!({"now": 1}), &ledger).unwrap();
        assert!(!value["$directives"].as_array().unwrap().is_empty());
        assert_eq!(ledger.last_request()["base"], 4);
    }
}
