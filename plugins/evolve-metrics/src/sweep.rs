// `sweep`：读轨迹窗口 + evidence 链 + verdicts/proposals 引用集 → 产清理计划
// （写新 evolution body 索引、不含过期条目）。保留回合数读 #33 thresholds；
// **不动被 verdict / proposal 引用的轨迹与证据**（否则 verdict → proposal → evidence → trace 溯源链断）。
// 清理只动索引，def 仍在链上（① 档既定代价，不是删除）。纯计算、同输入同输出。

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::bag;
use crate::plan;
use crate::thresholds::Thresholds;

/// 执行 sweep。
pub fn run(bag: &Value, env: &Value) -> Result<Value, (String, String)> {
    let traces = bag::trace_entries(bag);
    let evidence = bag::evidence_entries(bag);
    let thresholds = Thresholds::from_bag(bag);
    let now = bag::now_of(bag, env.get("now").unwrap_or(&Value::Null));
    let retention = thresholds.count("trace_retention_rounds", 50);
    let evidence_retention = thresholds.count("evidence_retention_rounds", 50);
    let referenced = referenced_trace_defs(bag);
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

    let body = bag::evolution_body(bag);
    let mut directives = Vec::new();
    if !traces.is_empty() || !evidence.is_empty() {
        if let Some(mut body) = body {
            match bag::base_of(bag) {
                Some(base) => {
                    // 补丁世代：只替换被清理的槽（trace / evidence），不重写整份台账 body
                    let mut patches = Vec::new();
                    if !traces.is_empty() {
                        patches.push(plan::replace_op(
                            json!(["trace"]),
                            index_of(&retained, swept, &now),
                        ));
                    }
                    if !evidence.is_empty() {
                        patches.push(plan::replace_op(
                            json!(["evidence"]),
                            index_of(&retained_evidence, evidence_swept, &now),
                        ));
                    }
                    directives.push(plan::batch_directive(vec![
                        plan::put_op(plan::patch_body(patches)),
                        plan::add_gen_op("evolution", 0, Some(base)),
                    ]));
                }
                None => {
                    if let Some(object) = body.as_object_mut() {
                        if !traces.is_empty() {
                            object.insert("trace".to_string(), index_of(&retained, swept, &now));
                        }
                        if !evidence.is_empty() {
                            object.insert(
                                "evidence".to_string(),
                                index_of(&retained_evidence, evidence_swept, &now),
                            );
                        }
                    }
                    directives.push(plan::batch_directive(vec![
                        plan::put_op(body),
                        plan::add_gen_op("evolution", 0, None),
                    ]));
                }
            }
        }
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
    entries: &'a [bag::TraceRef],
    retention: usize,
    referenced: &BTreeSet<String>,
    key: impl Fn(&bag::TraceRef) -> Option<String>,
) -> (Vec<&'a bag::TraceRef>, usize, usize) {
    let keep_from = entries.len().saturating_sub(retention);
    let is_referenced = |entry: &bag::TraceRef| {
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
fn index_of(retained: &[&bag::TraceRef], swept: usize, now: &Value) -> Value {
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
    fn sweep_windows_evidence_chain_keeping_referenced() {
        let bag = json!({
            "evolution": {
                "version": 1,
                "trace": {"tail": null, "count": 0},
                "evidence": {"tail": {"def": "e2"}, "count": 3},
                "proposals": {"tail": null, "count": 0},
                "verdicts": {"tail": null, "count": 0}
            },
            "refs": {
                "e2": {"kind": "evidence", "id": "ev-2", "prev": {"def": "e1"}},
                "e1": {"kind": "evidence", "id": "ev-1", "prev": {"def": "e0"}},
                "e0": {"kind": "evidence", "id": "ev-0", "prev": null}
            },
            "thresholds": {"evidence_retention_rounds": 1},
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-0"]}]
        });
        let value = run(&bag, &json!({"now": 5})).unwrap();
        assert_eq!(value["evidence_swept"], 1);
        assert_eq!(value["evidence_retained"], 2);
        assert_eq!(value["evidence_referenced"], 1);
        let ops = value["$directives"][0]["request"]["args"]["ops"]
            .as_array()
            .unwrap();
        let evidence = &ops[0]["args"]["body"]["evidence"];
        assert_eq!(evidence["dropped"], 1);
        let retained = evidence["retained"].as_array().unwrap();
        // 被 verdict 引用的旧证据 ev-0 强留，最新 ev-2 保留，过期 ev-1 移除。
        assert!(retained.contains(&json!({"def": "e0"})));
        assert!(retained.contains(&json!({"def": "e2"})));
    }

    #[test]
    fn evidence_window_uses_authoritative_retained_boundary() {
        // 下一拍：投影仍含被丢弃的 ev-1（prev 传递闭包），但窗口以 retained 为界。
        let bag = json!({
            "evolution": {
                "version": 1,
                "trace": {"tail": null, "count": 0},
                "evidence": {"tail": {"def": "e2"}, "count": 2,
                    "retained": [{"def": "e0"}, {"def": "e2"}]},
                "proposals": {"tail": null, "count": 0},
                "verdicts": {"tail": null, "count": 0}
            },
            "refs": {
                "e2": {"kind": "evidence", "id": "ev-2", "prev": {"def": "e1"}},
                "e1": {"kind": "evidence", "id": "ev-1", "prev": {"def": "e0"}},
                "e0": {"kind": "evidence", "id": "ev-0", "prev": null}
            },
            "thresholds": {"evidence_retention_rounds": 1},
            "verdicts": [{"kind": "verdict", "id": "vd-1", "evidence_ids": ["ev-0"]}]
        });
        let value = run(&bag, &json!({"now": 6})).unwrap();
        assert_eq!(value["evidence_swept"], 0);
        assert_eq!(value["evidence_retained"], 2);
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

    #[test]
    fn sweep_patch_generation_uses_bag_base_single_add_gen() {
        // 有数据世代时写补丁世代：单次调用只产一条 batch / 一个 evolution add_gen，base = bag 数据世代。
        // 同回合多次调用须由调用方按身份合并（本服务无跨调用回合状态）。
        let mut body = body();
        body["data_gen"] = json!({"seq": 4, "payload": "a".repeat(64)});
        let bag = json!({
            "trace_entries": [
                {"kind": "trace", "run": "old", "workspace_id": "w1", "outcome": "done", "def": "t0"},
                {"kind": "trace", "run": "new", "workspace_id": "w1", "outcome": "done", "def": "t1"}
            ],
            "thresholds": {"trace_retention_rounds": 1},
            "evolution": body
        });
        let value = run(&bag, &json!({"now": 1})).unwrap();
        let directives = value["$directives"].as_array().unwrap();
        assert_eq!(directives.len(), 1, "单次调用只产一条写 directive");
        let ops = directives[0]["request"]["args"]["ops"].as_array().unwrap();
        let add_gens: Vec<&Value> = ops.iter().filter(|op| op["op"] == "add_gen").collect();
        assert_eq!(add_gens.len(), 1, "单次调用只产一个 add_gen");
        assert_eq!(add_gens[0]["args"]["id"], "evolution");
        assert_eq!(add_gens[0]["args"]["base"], 4, "base 指向 bag 的数据世代");
    }
}
