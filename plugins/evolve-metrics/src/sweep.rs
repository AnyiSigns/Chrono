// `sweep`：读轨迹窗口 + verdicts 引用集 → 产清理计划（写新 evolution body 索引、不含过期条目）。
// 保留回合数读 #33 thresholds；**不动被 verdict 引用的轨迹**（否则 verdict → proposal → evidence → trace 溯源链断）。
// 清理只动索引，def 仍在链上（① 档既定代价，不是删除）。纯计算、同输入同输出。

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::bag;
use crate::plan;
use crate::thresholds::Thresholds;

/// 执行 sweep。
pub fn run(bag: &Value, env: &Value) -> Result<Value, (String, String)> {
    let traces = bag::trace_entries(bag);
    let thresholds = Thresholds::from_bag(bag);
    let now = bag::now_of(bag, env.get("now").unwrap_or(&Value::Null));
    let retention = thresholds.count("trace_retention_rounds", 50);
    let referenced = referenced_trace_defs(bag);

    // 保留 = 最新 retention 条 ∪ 被 verdict 引用者（无论多旧）。
    let keep_from = traces.len().saturating_sub(retention);
    let mut retained: Vec<&bag::TraceRef> = Vec::new();
    let mut retained_defs: BTreeSet<String> = BTreeSet::new();
    for (index, trace) in traces.iter().enumerate() {
        let is_recent = index >= keep_from;
        let is_referenced = trace
            .def
            .as_ref()
            .map(|hash| referenced.contains(hash))
            .unwrap_or(false);
        if is_recent || is_referenced {
            retained.push(trace);
            if let Some(hash) = &trace.def {
                retained_defs.insert(hash.clone());
            }
        }
    }
    let swept = traces.len() - retained.len();
    let referenced_kept = retained_defs.intersection(&referenced).count();

    let body = bag::evolution_body(bag);
    let mut directives = Vec::new();
    if !traces.is_empty() {
        if let Some(mut body) = body {
            let tail = retained
                .last()
                .and_then(|trace| trace.def.clone())
                .map(|hash| json!({ "def": hash }))
                .unwrap_or(Value::Null);
            let retained_list: Vec<Value> = retained
                .iter()
                .filter_map(|trace| trace.def.clone())
                .map(|hash| json!({ "def": hash }))
                .collect();
            if let Some(object) = body.as_object_mut() {
                object.insert(
                    "trace".to_string(),
                    json!({
                        "tail": tail,
                        "count": retained.len(),
                        "retained": retained_list,
                        "dropped": swept,
                        "swept_at": now,
                    }),
                );
            }
            directives.push(plan::batch_directive(vec![
                plan::put_op(body),
                plan::add_gen_op("evolution", 0),
            ]));
        }
    }

    let mut result = Map::new();
    result.insert("swept".to_string(), json!(swept));
    result.insert("retained".to_string(), json!(retained.len()));
    result.insert("referenced".to_string(), json!(referenced_kept));
    result.insert("$directives".to_string(), Value::Array(directives));
    Ok(Value::Object(result))
}

/// 被 verdict 引用的轨迹 def 集：显式集 ∪ verdict → evidence_ids → evidence.traces[].def。
fn referenced_trace_defs(bag: &Value) -> BTreeSet<String> {
    let mut referenced = BTreeSet::new();
    if let Some(items) = bag.get("referenced_trace_defs").and_then(Value::as_array) {
        for item in items {
            if let Some(hash) = item.as_str() {
                referenced.insert(hash.to_string());
            }
        }
    }

    let mut entries: Vec<Value> = Vec::new();
    if let Some(refs) = bag::refs_map(bag).as_object() {
        entries.extend(refs.values().cloned());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referenced_defs_from_verdict_chain() {
        let bag = json!({
            "evidence": [
                {"kind": "evidence", "id": "ev-1", "traces": [{"def": "t-old"}]}
            ],
            "verdicts": [
                {"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-1"]}
            ]
        });
        let referenced = referenced_trace_defs(&bag);
        assert!(referenced.contains("t-old"));
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
    fn sweep_keeps_referenced_traces_and_drops_expired() {
        let bag = json!({
            "trace_entries": [
                {"kind": "trace", "run": "old", "workspace_id": "w1", "outcome": "done", "def": "t0"},
                {"kind": "trace", "run": "mid", "workspace_id": "w1", "outcome": "done", "def": "t1"},
                {"kind": "trace", "run": "new", "workspace_id": "w1", "outcome": "done", "def": "t2"}
            ],
            "thresholds": {"trace_retention_rounds": 1},
            "evidence": [{"kind": "evidence", "id": "ev-1", "traces": [{"def": "t0"}]}],
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-1"]}],
            "evolution": body()
        });
        let value = run(&bag, &json!({"now": 9})).unwrap();
        assert_eq!(value["swept"], 1);
        assert_eq!(value["retained"], 2);
        assert_eq!(value["referenced"], 1);
        let ops = value["$directives"][0]["request"]["args"]["ops"]
            .as_array()
            .unwrap();
        assert_eq!(ops[0]["op"], "put");
        assert_eq!(ops[1]["op"], "add_gen");
        let retained = ops[0]["args"]["body"]["trace"]["retained"].as_array().unwrap();
        // 被 verdict 引用的旧轨迹 t0 强留，最新 t2 保留，过期 t1 从索引移除。
        assert_eq!(retained.len(), 2);
        assert!(retained.contains(&json!({"def": "t0"})));
        assert!(retained.contains(&json!({"def": "t2"})));
        assert_eq!(ops[0]["args"]["body"]["trace"]["dropped"], 1);
    }

    #[test]
    fn consecutive_sweeps_shrink_window_without_repeating() {
        let first_bag = json!({
            "trace_entries": [
                {"kind": "trace", "run": "old", "workspace_id": "w1", "outcome": "done", "def": "t0"},
                {"kind": "trace", "run": "mid", "workspace_id": "w1", "outcome": "done", "def": "t1"},
                {"kind": "trace", "run": "new", "workspace_id": "w1", "outcome": "done", "def": "t2"}
            ],
            "thresholds": {"trace_retention_rounds": 1},
            "evidence": [{"kind": "evidence", "id": "ev-1", "traces": [{"def": "t0"}]}],
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-1"]}],
            "evolution": body()
        });
        let first = run(&first_bag, &json!({"now": 1})).unwrap();
        assert_eq!(first["swept"], 1);
        assert_eq!(first["retained"], 2);
        let new_body = first["$directives"][0]["request"]["args"]["ops"][0]["args"]["body"].clone();
        let retained = new_body["trace"]["retained"].as_array().unwrap();
        assert_eq!(retained.len(), 2);

        // 下一拍：投影仍含被丢弃的 t1（tail 标记的传递闭包），但窗口以 retained 为界。
        let refs = json!({
            "t2": {"kind": "trace", "run": "new", "outcome": "done", "prev": {"def": "t1"}},
            "t1": {"kind": "trace", "run": "mid", "outcome": "done", "prev": {"def": "t0"}},
            "t0": {"kind": "trace", "run": "old", "outcome": "done", "prev": null}
        });
        let second_bag = json!({
            "trace": {"body": new_body, "refs": refs},
            "thresholds": {"trace_retention_rounds": 1},
            "evidence": [{"kind": "evidence", "id": "ev-1", "traces": [{"def": "t0"}]}],
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-1"]}]
        });
        let second = run(&second_bag, &json!({"now": 2})).unwrap();
        // 窗口已缩到 2 条，不再重复清理已丢弃的 t1。
        assert_eq!(second["swept"], 0);
        assert_eq!(second["retained"], 2);
    }

    #[test]
    fn sweep_without_traces_writes_nothing() {
        let value = run(&json!({"evolution": body()}), &json!({})).unwrap();
        assert_eq!(value["swept"], 0);
        assert!(value["$directives"].as_array().unwrap().is_empty());
    }
}
