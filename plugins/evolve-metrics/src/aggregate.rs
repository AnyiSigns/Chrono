// `aggregate`：读轨迹窗口 → 产七类证据 → 返回写计划（batch：证据条目 + 新 evolution body 索引）。
// 同时按「最近连续 refused 收口」发 `orchestration.unhealthy` 事件（N 读 thresholds，与 ui-settings 同口径）。
// 只产 kind:'evidence' 条目，不产提案；纯计算、同输入同输出。
// 链窗口 / 阈值解析 / 写计划构造经 `evolve-ledger` 反向调用。

use serde_json::{json, Map, Value};

use crate::error::ServiceError;
use crate::evidence;
use crate::ledger::{directives_of, Ledger};
use crate::port::EventSink;
use crate::state::StateStore;
use crate::thresholds::Thresholds;

/// 执行 aggregate：`bag` 为调用方装配（周期路径由宿主 reads 注入），`env` 为调用帧 env。
pub fn run(
    bag: &Value,
    env: &Value,
    events: &dyn EventSink,
    state: &dyn StateStore,
    ledger: &dyn Ledger,
) -> Result<Value, (String, String)> {
    let env = effective_env(bag, env);
    let windows = ledger.read_chain(bag).map_err(as_tuple)?;
    let thresholds = Thresholds::from_values(&ledger.thresholds(bag).map_err(as_tuple)?);
    let refusal_codes = windows.refusal_codes.clone();
    let now = now_of(bag, &env);
    let options = evidence::Options {
        thresholds: &thresholds,
        now: &now,
        refusal_codes: &refusal_codes,
        state: Some(state),
    };
    let mut built = evidence::build(&windows.trace, &options, ledger).map_err(as_tuple)?;

    // 数据变化的机械通知（非业务判定，符合 protocol.md §2.5）：宿主透传 → ui-notify / ui-settings。
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

    let body = windows.body.clone();
    let prev_tail = body
        .as_ref()
        .and_then(|value| value.pointer("/evidence/tail").cloned())
        .filter(|value| !value.is_null());

    let mut entries = built.evidence;
    for (index, entry) in entries.iter_mut().enumerate() {
        let prev = if index == 0 {
            prev_tail.clone().unwrap_or(Value::Null)
        } else {
            chain_ref(index - 1)
        };
        if let Some(object) = entry.as_object_mut() {
            object.insert("prev".to_string(), prev);
        }
    }

    let mut directives = Vec::new();
    if !entries.is_empty() {
        if let Some(body) = body {
            let request = json!({
                "gen_id": "evolution",
                "body": body,
                "base": windows.base,
                "append": { "section": "evidence", "entries": entries.clone() },
            });
            let plan = ledger.patch_plan(&request).map_err(as_tuple)?;
            directives = directives_of(&plan);
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

/// 入参中可携带的调用帧 env（宿主直接填帧 env；`bag.__env` 兼容旧门面转交形状）。
fn effective_env(args: &Value, env: &Value) -> Value {
    if env.is_object() {
        env.clone()
    } else {
        args.get("__env").cloned().unwrap_or(Value::Null)
    }
}

/// `now`：bag 优先，其次调用帧 env。
fn now_of(bag: &Value, env: &Value) -> Value {
    if let Some(now) = bag.get("now") {
        if !now.is_null() {
            return now.clone();
        }
    }
    env.get("now").cloned().unwrap_or(Value::Null)
}

/// 链指针：指向同批第 `index` 条 put 的 def 键。
fn chain_ref(index: usize) -> Value {
    json!({ "def": { "$n": index } })
}

fn as_tuple(error: ServiceError) -> (String, String) {
    (error.code, error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ChainWindows;
    use crate::port::CapturingEventSink;
    use crate::state::MemoryStateStore;
    use std::sync::Mutex;

    /// 单测用假台账：回放预设窗口 / 阈值，并捕获 patch_plan 请求。
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
                plan: json!({ "$directives": [] }),
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
        fn hashes(&self, values: &[Value], _mode: &str) -> Result<Vec<String>, ServiceError> {
            Ok(values
                .iter()
                .enumerate()
                .map(|(index, _)| format!("{index:016x}"))
                .collect())
        }
        fn patch_plan(&self, request: &Value) -> Result<Value, ServiceError> {
            *self.last_request.lock().unwrap() = request.clone();
            Ok(self.plan.clone())
        }
    }

    fn body() -> Value {
        json!({
            "version": 1,
            "trace": {"tail": null, "count": 0},
            "evidence": {"tail": null, "count": 0},
            "proposals": {"tail": null, "count": 0},
            "verdicts": {"tail": null, "count": 0}
        })
    }

    fn refused_trace(run: &str) -> crate::chain::TraceRef {
        crate::chain::TraceRef {
            def: Some(format!("def-{run}")),
            body: json!({
                "kind": "trace", "run": run, "workspace_id": "w1", "outcome": "refused",
                "refused_at": {"node_index": 1, "code": "capability_mismatch", "attributable_to": "graph"}
            }),
        }
    }

    #[test]
    fn aggregate_plan_request_chains_evidence_and_body() {
        let mut ledger = TestLedger::new(ChainWindows {
            trace: vec![refused_trace("r1"), refused_trace("r2")],
            body: Some(body()),
            ..ChainWindows::default()
        });
        ledger.thresholds = json!({"failure_cluster_n": 2});
        ledger.plan = json!({"$directives": [{"kind": "write"}]});
        let events = CapturingEventSink::new();
        let state = MemoryStateStore::new();
        let value = run(&json!({}), &json!({"now": 1}), &events, &state, &ledger).unwrap();
        assert_eq!(value["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(value["evidence"][0]["class"], "failure_cluster");
        assert_eq!(value["evidence"][0]["prev"], Value::Null);
        assert!(!value["$directives"].as_array().unwrap().is_empty());
        let request = ledger.last_request();
        assert_eq!(request["append"]["section"], "evidence");
        assert_eq!(request["append"]["entries"].as_array().unwrap().len(), 1);
        assert_eq!(request["body"]["evidence"]["count"], 0);
    }

    #[test]
    fn aggregate_without_evolution_body_emits_no_write() {
        let mut ledger = TestLedger::new(ChainWindows {
            trace: vec![refused_trace("r1")],
            body: None,
            ..ChainWindows::default()
        });
        ledger.thresholds = json!({"failure_cluster_n": 1});
        let events = CapturingEventSink::new();
        let state = MemoryStateStore::new();
        let value = run(&json!({}), &json!({"now": 1}), &events, &state, &ledger).unwrap();
        assert_eq!(value["evidence"].as_array().unwrap().len(), 1);
        assert!(value["$directives"].as_array().unwrap().is_empty());
        assert_eq!(ledger.last_request(), Value::Null, "无 body 不得请求写计划");
    }

    #[test]
    fn aggregate_patch_generation_carries_bag_base() {
        let mut windows = ChainWindows {
            trace: vec![refused_trace("r1"), refused_trace("r2")],
            body: Some(body()),
            base: Some(6),
            ..ChainWindows::default()
        };
        windows.body.as_mut().unwrap()["data_gen"] = json!({"seq": 6, "payload": "a"});
        let mut ledger = TestLedger::new(windows);
        ledger.thresholds = json!({"failure_cluster_n": 2});
        let events = CapturingEventSink::new();
        let state = MemoryStateStore::new();
        let _ = run(&json!({}), &json!({"now": 1}), &events, &state, &ledger).unwrap();
        assert_eq!(ledger.last_request()["base"], 6, "base 指向 bag 的数据世代");
    }

    #[test]
    fn aggregate_emits_unhealthy_event_when_threshold_reached() {
        let mut ledger = TestLedger::new(ChainWindows {
            trace: vec![refused_trace("r1"), refused_trace("r2"), refused_trace("r3")],
            ..ChainWindows::default()
        });
        ledger.thresholds = json!({"unhealthy_refused_streak": 3});
        let events = CapturingEventSink::new();
        let state = MemoryStateStore::new();
        let value = run(
            &json!({}),
            &json!({"run": "cycle-run", "thread": null, "now": 1}),
            &events,
            &state,
            &ledger,
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
