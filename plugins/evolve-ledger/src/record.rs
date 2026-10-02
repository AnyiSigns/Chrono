// `record`：user_request 证据生产者。经 tools 的能力类工具绑定暴露，工具名 `record` 直绑 `evolve-metrics.record`（同一二进制的能力类）。
// 把用户原始消息 def 落成一条 `class:'user_request'` 证据写计划
// （put(证据) + put(新 evolution body) + add_gen），返回 `evidence_id`。纯计算、不调模型、不发 eff——
// 分签红线：证据归本提供方，orchestration 只引用 evidence_id。链窗口 / 哈希 / 写计划经 `evolve-ledger`。

use serde_json::{json, Map, Value};

use crate::error::ServiceError;
use crate::ledger::{directives_of, Ledger};

/// 执行 record。
pub fn run(bag: &Value, env: &Value, ledger: &dyn Ledger) -> Result<Value, (String, String)> {
    let env = effective_env(bag, env);
    let Some(user_message_def) = bag.get("user_message_def").filter(|value| !value.is_null()) else {
        return Err(("bad_args".to_string(), "missing user_message_def".to_string()));
    };
    let workspace_id = bag
        .get("workspace_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("bad_args".to_string(), "missing workspace_id".to_string()))?
        .to_string();
    let now = now_of(bag, &env);
    let run_id = env
        .get("run")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let source_message = source_message_of(user_message_def);
    // 与拆分前同口径：FNV-1a 64 over `user_request|workspace|canonical(source_message)`。
    let canonical_source = serde_json::to_string(&source_message).unwrap_or_default();
    let id_string = format!("user_request|{workspace_id}|{canonical_source}");
    let hashes = ledger.hashes(&[json!(id_string)], "fnv").map_err(as_tuple)?;
    let hash = hashes.first().cloned().unwrap_or_default();
    let evidence_id = format!("ev-{hash}");
    let cluster_key = json!({
        "code": "user_request",
        "attributable_to": "user",
        "workspace_id": workspace_id,
        "contract_id": Value::Null,
    });

    let windows = ledger.read_chain(bag).map_err(as_tuple)?;
    let body = windows.body.clone();
    let prev_tail = body
        .as_ref()
        .and_then(|value| value.pointer("/evidence/tail").cloned())
        .filter(|value| !value.is_null());

    let mut entry = Map::new();
    entry.insert("kind".to_string(), json!("evidence"));
    entry.insert("id".to_string(), json!(evidence_id));
    entry.insert("class".to_string(), json!("user_request"));
    entry.insert("cluster_key".to_string(), cluster_key);
    entry.insert("n".to_string(), json!(1));
    entry.insert(
        "window".to_string(),
        json!({ "from_run": run_id, "to_run": run_id }),
    );
    entry.insert("traces".to_string(), json!([]));
    entry.insert("source_message".to_string(), source_message);
    entry.insert("at".to_string(), now);
    entry.insert("prev".to_string(), prev_tail.unwrap_or(Value::Null));
    entry.insert("attributable_to".to_string(), json!("user"));
    // 用户请求是偏好、不是能力缺口。
    entry.insert("capability_gap".to_string(), json!(false));
    entry.insert("scope_support".to_string(), json!("none"));
    let entry = Value::Object(entry);

    let mut directives = Vec::new();
    if let Some(body) = body {
        let request = json!({
            "gen_id": "evolution",
            "body": body,
            "base": windows.base,
            "append": { "section": "evidence", "entries": [entry] },
        });
        let plan = ledger.patch_plan(&request).map_err(as_tuple)?;
        directives = directives_of(&plan);
    }

    let mut result = Map::new();
    result.insert("evidence_id".to_string(), json!(evidence_id));
    result.insert("$directives".to_string(), Value::Array(directives));
    Ok(Value::Object(result))
}

/// 原始消息 def：`{def:hash}` 原样；字符串包成 `{def}`；其余内联进 `{inline}` 以便溯源。
fn source_message_of(value: &Value) -> Value {
    if value.get("def").is_some() {
        return value.clone();
    }
    if let Some(hash) = value.as_str() {
        return json!({ "def": hash });
    }
    json!({ "def": Value::Null, "inline": value })
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
        hashes: Vec<String>,
        plan: Value,
        last_request: Mutex<Value>,
    }

    impl TestLedger {
        fn new(windows: ChainWindows) -> Self {
            Self {
                windows,
                hashes: vec!["deadbeef".to_string()],
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
            Ok(json!({}))
        }
        fn hashes(&self, _values: &[Value], _mode: &str) -> Result<Vec<String>, ServiceError> {
            Ok(self.hashes.clone())
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

    #[test]
    fn record_plan_shape() {
        let ledger = TestLedger::new(ChainWindows {
            body: Some(body()),
            ..ChainWindows::default()
        });
        let bag = json!({"user_message_def": {"def": "msg-hash"}, "workspace_id": "w1"});
        let value = run(&bag, &json!({"run": "r9", "now": 3}), &ledger).unwrap();
        assert_eq!(value["evidence_id"], "ev-deadbeef");
        assert!(!value["$directives"].as_array().unwrap().is_empty());
        let request = ledger.last_request();
        let entries = request["append"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["class"], "user_request");
        assert_eq!(entries[0]["source_message"]["def"], "msg-hash");
        assert_eq!(entries[0]["cluster_key"]["attributable_to"], "user");
        assert_eq!(entries[0]["capability_gap"], false);
        assert_eq!(entries[0]["prev"], Value::Null);
    }

    #[test]
    fn record_patch_generation_carries_bag_base() {
        let ledger = TestLedger::new(ChainWindows {
            body: Some(body()),
            base: Some(3),
            ..ChainWindows::default()
        });
        let bag = json!({"user_message_def": {"def": "msg-hash"}, "workspace_id": "w1"});
        let value = run(&bag, &json!({"run": "r9", "now": 3}), &ledger).unwrap();
        assert!(value.get("$directives").is_some());
        assert_eq!(ledger.last_request()["base"], 3);
    }

    #[test]
    fn record_without_body_emits_no_write() {
        let ledger = TestLedger::new(ChainWindows::default());
        let bag = json!({"user_message_def": {"def": "msg-hash"}, "workspace_id": "w1"});
        let value = run(&bag, &json!({"run": "r9"}), &ledger).unwrap();
        assert_eq!(value["evidence_id"], "ev-deadbeef");
        assert!(value["$directives"].as_array().unwrap().is_empty());
        assert_eq!(ledger.last_request(), Value::Null);
    }

    #[test]
    fn record_missing_fields_is_bad_args() {
        let ledger = TestLedger::new(ChainWindows::default());
        assert_eq!(run(&json!({}), &json!({}), &ledger).unwrap_err().0, "bad_args");
        assert_eq!(
            run(&json!({"user_message_def": {"def": "x"}}), &json!({}), &ledger)
                .unwrap_err()
                .0,
            "bad_args"
        );
    }
}
