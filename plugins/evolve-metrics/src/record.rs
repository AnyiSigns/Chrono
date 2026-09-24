// `record`：user_request 证据生产者（v1 闭环）。经 #27 的能力类工具绑定暴露，工具名 `record` 直绑本方法。
// 把用户原始消息 def 落成一条 `class:'user_request'` 证据写计划（put(证据) + put(新 evolution body) + add_gen），
// 返回 `evidence_id`。纯计算、不调模型、不发 eff——分签红线：证据归 #44，#45 只引用 evidence_id。

use serde_json::{json, Map, Value};

use crate::bag;
use crate::hash;
use crate::plan;

/// 执行 record。
pub fn run(bag: &Value, env: &Value) -> Result<Value, (String, String)> {
    let Some(user_message_def) = bag.get("user_message_def").filter(|value| !value.is_null()) else {
        return Err(("bad_args".to_string(), "missing user_message_def".to_string()));
    };
    let workspace_id = bag
        .get("workspace_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("bad_args".to_string(), "missing workspace_id".to_string()))?
        .to_string();
    let now = bag::now_of(bag, env.get("now").unwrap_or(&Value::Null));
    let run_id = env
        .get("run")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let source_message = source_message_of(user_message_def);
    let evidence_id = format!(
        "ev-{}",
        hash::hash64(&format!(
            "user_request|{workspace_id}|{}",
            hash::canonical(&source_message)
        ))
    );
    let cluster_key = json!({
        "code": "user_request",
        "attributable_to": "user",
        "workspace_id": workspace_id,
        "contract_id": Value::Null,
    });

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
    if let Some(mut body) = body {
        let mut ops = vec![plan::put_op(entry.clone())];
        // 追加新证据：整体替换 evidence 索引，清掉 sweep 的窗口字段（同 aggregate）。
        let new_evidence = json!({
            "tail": plan::chain_ref(0),
            "count": old_count + 1,
        });
        match bag::base_of(bag) {
            Some(base) => {
                // 补丁世代：只替换 evidence 槽，不重写整份台账 body
                ops.push(plan::put_op(plan::patch_body(vec![plan::replace_op(
                    json!(["evidence"]),
                    new_evidence,
                )])));
                ops.push(plan::add_gen_op("evolution", 1, Some(base)));
            }
            None => {
                if let Some(object) = body.as_object_mut() {
                    object.insert("evidence".to_string(), new_evidence);
                }
                ops.push(plan::put_op(body));
                ops.push(plan::add_gen_op("evolution", 1, None));
            }
        }
        directives.push(plan::batch_directive(ops));
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let bag = json!({
            "user_message_def": {"def": "msg-hash"},
            "workspace_id": "w1",
            "evolution": body()
        });
        let value = run(&bag, &json!({"run": "r9", "now": 3})).unwrap();
        let evidence_id = value["evidence_id"].as_str().unwrap();
        assert!(evidence_id.starts_with("ev-"));
        let ops = value["$directives"][0]["request"]["args"]["ops"]
            .as_array()
            .unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0]["op"], "put");
        assert_eq!(ops[0]["args"]["body"]["class"], "user_request");
        assert_eq!(ops[0]["args"]["body"]["source_message"]["def"], "msg-hash");
        assert_eq!(ops[0]["args"]["body"]["cluster_key"]["attributable_to"], "user");
        assert_eq!(ops[0]["args"]["body"]["capability_gap"], false);
        assert_eq!(ops[1]["op"], "put");
        assert_eq!(ops[2]["op"], "add_gen");
        assert_eq!(ops[2]["args"]["id"], "evolution");
        assert_eq!(ops[1]["args"]["body"]["evidence"]["tail"], json!({"def": {"$n": 0}}));
        assert_eq!(ops[1]["args"]["body"]["evidence"]["count"], 1);
    }

    #[test]
    fn record_patch_generation_when_base_present() {
        let bag = json!({
            "user_message_def": {"def": "msg-hash"},
            "workspace_id": "w1",
            "evolution": {
                "version": 1,
                "trace": {"tail": null, "count": 0},
                "evidence": {"tail": null, "count": 0},
                "proposals": {"tail": null, "count": 0},
                "verdicts": {"tail": null, "count": 0},
                "data_gen": {"seq": 3, "payload": "a".repeat(64)}
            }
        });
        let value = run(&bag, &json!({"run": "r9", "now": 3})).unwrap();
        let ops = value["$directives"][0]["request"]["args"]["ops"]
            .as_array()
            .unwrap();
        assert_eq!(ops.len(), 3);
        assert!(ops[1]["args"]["body"]["ops"].is_array(), "应写补丁 def");
        assert_eq!(ops[1]["args"]["body"]["ops"][0]["path"], json!(["evidence"]));
        assert_eq!(ops[1]["args"]["body"]["ops"][0]["value"]["count"], 1);
        assert_eq!(ops[2]["args"]["base"], 3);
    }

    #[test]
    fn record_is_deterministic() {
        let bag = json!({
            "user_message_def": {"def": "msg-hash"},
            "workspace_id": "w1",
            "evolution": body()
        });
        let first = run(&bag, &json!({"run": "r9"})).unwrap();
        let second = run(&bag, &json!({"run": "r9"})).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn record_missing_fields_is_bad_args() {
        assert_eq!(run(&json!({}), &json!({})).unwrap_err().0, "bad_args");
        assert_eq!(
            run(&json!({"user_message_def": {"def": "x"}}), &json!({})).unwrap_err().0,
            "bad_args"
        );
    }
}
