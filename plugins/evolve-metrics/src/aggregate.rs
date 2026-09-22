// `aggregate`：读轨迹窗口 → 产七类证据 → 返回写计划（batch：证据条目 + 新 evolution body 索引）。
// 同时按「最近连续 refused 收口」发 `orchestration.unhealthy` 事件（N 读 #33 thresholds，与 #17 同口径）。
// 只产 kind:'evidence' 条目，不产提案；纯计算、同输入同输出。

use serde_json::{json, Map, Value};

use crate::bag;
use crate::evidence;
use crate::plan;
use crate::port::EventSink;
use crate::state::StateStore;
use crate::thresholds::Thresholds;

/// 执行 aggregate：`bag` 为调用方装配（周期路径由宿主 reads 注入），`env` 为调用帧 env。
pub fn run(
    bag: &Value,
    env: &Value,
    events: &dyn EventSink,
    state: &dyn StateStore,
) -> Result<Value, (String, String)> {
    let traces = bag::trace_entries(bag);
    let thresholds = Thresholds::from_bag(bag);
    let refusal_codes = bag::refusal_codes(bag);
    let now = bag::now_of(bag, env.get("now").unwrap_or(&Value::Null));
    let options = evidence::Options {
        thresholds: &thresholds,
        now: &now,
        refusal_codes: &refusal_codes,
        state: Some(state),
    };
    let mut built = evidence::build(&traces, &options);

    // 数据变化的机械通知（非业务判定，符合 protocol.md §2.5）：宿主透传 → #38 / #17。
    // 载荷按 §2.5 带 `run` / `thread`（取调用帧 env；周期 run 的 `thread:null`）。
    if let Some(mut payload) = built.unhealthy.take() {
        if let Some(object) = payload.as_object_mut() {
            let run = env
                .get("run")
                .cloned()
                .filter(|value| !value.is_null())
                .or_else(|| object.get("run").cloned())
                .unwrap_or(Value::Null);
            object.insert("run".to_string(), run);
            object.insert(
                "thread".to_string(),
                env.get("thread").cloned().unwrap_or(Value::Null),
            );
        }
        events.emit("orchestration.unhealthy", payload.clone());
        built.unhealthy = Some(payload);
    }

    let body = bag::evolution_body(bag);
    let prev_tail = body
        .as_ref()
        .and_then(|value| value.pointer("/evidence/tail").cloned())
        .filter(|value| !value.is_null());
    let old_count = body
        .as_ref()
        .and_then(|value| value.pointer("/evidence/count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let mut entries = built.evidence;
    for (index, entry) in entries.iter_mut().enumerate() {
        let prev = if index == 0 {
            prev_tail.clone().unwrap_or(Value::Null)
        } else {
            plan::chain_ref(index - 1)
        };
        if let Some(object) = entry.as_object_mut() {
            object.insert("prev".to_string(), prev);
        }
    }

    let mut directives = Vec::new();
    if !entries.is_empty() {
        if let Some(mut body) = body {
            let mut ops = Vec::new();
            for entry in &entries {
                ops.push(plan::put_op(entry.clone()));
            }
            let body_index = ops.len();
            if let Some(object) = body.as_object_mut() {
                let evidence = object
                    .entry("evidence".to_string())
                    .or_insert_with(|| json!({}));
                if let Some(evidence) = evidence.as_object_mut() {
                    evidence.insert("tail".to_string(), plan::chain_ref(body_index - 1));
                    evidence.insert("count".to_string(), json!(old_count + entries.len() as u64));
                }
            }
            ops.push(plan::put_op(body));
            ops.push(plan::add_gen_op("evolution", body_index));
            directives.push(plan::batch_directive(ops));
        }
    }

    let mut result = Map::new();
    result.insert("evidence".to_string(), Value::Array(entries));
    result.insert(
        "unhealthy".to_string(),
        built.unhealthy.unwrap_or_else(|| json!({ "fired": false })),
    );
    result.insert("$directives".to_string(), Value::Array(directives));
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::CapturingEventSink;
    use crate::state::MemoryStateStore;

    fn body() -> Value {
        json!({
            "version": 1,
            "trace": {"tail": null, "count": 0},
            "evidence": {"tail": null, "count": 0},
            "proposals": {"tail": null, "count": 0},
            "verdicts": {"tail": null, "count": 0}
        })
    }

    #[test]
    fn aggregate_plan_chains_evidence_and_index() {
        let bag = json!({
            "trace_entries": [
                {"kind": "trace", "run": "r1", "workspace_id": "w1", "outcome": "refused",
                 "refused_at": {"node_index": 1, "code": "capability_mismatch", "attributable_to": "graph"}},
                {"kind": "trace", "run": "r2", "workspace_id": "w1", "outcome": "refused",
                 "refused_at": {"node_index": 1, "code": "capability_mismatch", "attributable_to": "graph"}}
            ],
            "thresholds": {"failure_cluster_n": 2},
            "evolution": body()
        });
        let events = CapturingEventSink::new();
        let state = MemoryStateStore::new();
        let value = run(&bag, &json!({"now": 1}), &events, &state).unwrap();
        assert_eq!(value["evidence"].as_array().unwrap().len(), 1);
        let ops = value["$directives"][0]["request"]["args"]["ops"]
            .as_array()
            .unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0]["op"], "put");
        assert_eq!(ops[0]["args"]["body"]["prev"], Value::Null);
        assert_eq!(ops[1]["op"], "put");
        assert_eq!(ops[1]["args"]["body"]["evidence"]["tail"], json!({"def": {"$n": 0}}));
        assert_eq!(ops[1]["args"]["body"]["evidence"]["count"], 1);
        assert_eq!(ops[2]["op"], "add_gen");
        assert_eq!(ops[2]["args"]["payload"], json!({"$n": 1}));
    }

    #[test]
    fn aggregate_without_evolution_body_emits_no_write() {
        let bag = json!({
            "trace_entries": [{"kind": "trace", "run": "r1", "workspace_id": "w1",
                "outcome": "refused",
                "refused_at": {"node_index": 1, "code": "x", "attributable_to": "graph"}}],
            "thresholds": {"failure_cluster_n": 1}
        });
        let events = CapturingEventSink::new();
        let state = MemoryStateStore::new();
        let value = run(&bag, &json!({"now": 1}), &events, &state).unwrap();
        assert_eq!(value["evidence"].as_array().unwrap().len(), 1);
        // 没有当前 evolution body 时不产出会清空台账的写计划。
        assert!(value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn aggregate_emits_unhealthy_event_when_threshold_reached() {
        let bag = json!({
            "trace_entries": [
                {"kind": "trace", "run": "r1", "workspace_id": "w1", "outcome": "refused"},
                {"kind": "trace", "run": "r2", "workspace_id": "w1", "outcome": "refused"},
                {"kind": "trace", "run": "r3", "workspace_id": "w1", "outcome": "refused"}
            ],
            "thresholds": {"unhealthy_refused_streak": 3}
        });
        let events = CapturingEventSink::new();
        let state = MemoryStateStore::new();
        let value = run(
            &bag,
            &json!({"run": "cycle-run", "thread": null, "now": 1}),
            &events,
            &state,
        )
        .unwrap();
        assert_eq!(value["unhealthy"]["fired"], true);
        assert_eq!(events.events().len(), 1);
        assert_eq!(events.events()[0].0, "orchestration.unhealthy");
        assert_eq!(events.events()[0].1["streak"], 3);
        // 载荷按 protocol.md §2.5 带调用帧 run/thread；周期 run 的 thread 为 null。
        assert_eq!(events.events()[0].1["run"], "cycle-run");
        assert_eq!(events.events()[0].1["thread"], Value::Null);
        assert_eq!(value["unhealthy"]["run"], "cycle-run");
    }
}
