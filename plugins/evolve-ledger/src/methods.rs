// 台账原语的四个方法：read-chain / patch-plan / thresholds / hash。
// 纯计算、同输入同输出；服务不读投影、无写通道，一切输入随 args 传入，一切写经计划值交宿主落账。

use serde_json::{json, Map, Value};

use crate::bag;
use crate::hash;
use crate::plan;
use crate::thresholds::Thresholds;

/// 取入参：`{bag}` 包装优先，否则整个 args 视为 bag。
fn bag_arg(args: &Value) -> Value {
    args.get("bag").cloned().unwrap_or_else(|| args.clone())
}

/// `read-chain`：把 bag 解析成链窗口与写计划所需的形状。
/// 条目跨身份线形 `{def, body}`；`body` / `base` 缺省为 `null`；`refusal_codes` 为码→归因表。
pub fn read_chain(args: &Value) -> Value {
    let bag = bag_arg(args);
    let trace: Vec<Value> = bag::trace_entries(&bag).iter().map(bag::TraceRef::to_json).collect();
    let evidence: Vec<Value> = bag::evidence_entries(&bag).iter().map(bag::TraceRef::to_json).collect();
    let body = bag::evolution_body(&bag).unwrap_or(Value::Null);
    let base = bag::base_of(&bag).map(|seq| json!(seq)).unwrap_or(Value::Null);
    let refs = bag::refs_map(&bag);
    let refusal_codes = bag::refusal_codes(&bag);
    json!({
        "trace": trace,
        "evidence": evidence,
        "body": body,
        "base": base,
        "refs": refs,
        "refusal_codes": refusal_codes,
    })
}

/// `thresholds`：把 bag 的 `thresholds` 解析成扁平 `{name: number}`。
pub fn thresholds(args: &Value) -> Value {
    let bag = bag_arg(args);
    json!({ "values": Thresholds::from_bag(&bag).to_map() })
}

/// `hash`：对 `values` 按 `mode` 批量求哈希。
/// mode：`content`（FNV-1a 64 over canonical）/ `canonical`（规范 JSON 串）/ `kernel`（内核 H）/ `fnv`（字面串 FNV）。
pub fn hash_method(args: &Value) -> Result<Value, (String, String)> {
    let values = args
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| ("bad_args".to_string(), "values array required".to_string()))?;
    let mode = args.get("mode").and_then(Value::as_str).unwrap_or("content");
    let mut hashes = Vec::with_capacity(values.len());
    for value in values {
        let out = match mode {
            "content" => hash::content_hash(value),
            "canonical" => hash::canonical(value),
            "kernel" => hash::kernel_hash(value),
            "fnv" => value.as_str().map(hash::hash64).unwrap_or_default(),
            other => {
                return Err(("bad_args".to_string(), format!("unknown hash mode {other}")));
            }
        };
        hashes.push(Value::String(out));
    }
    Ok(json!({ "hashes": hashes }))
}

/// `patch-plan`：构造台账写计划。三种形态：
/// - `append`：向某 section 追加条目（自动串 `prev`、刷新 `tail`/`count`、按 `base` 决定整份/补丁世代）；
/// - `replace`：以给定索引整体替换 section（`sweep` 用；只替换传入的 section）；
/// - `puts`：只产 `put` 批（无 `add_gen`），供无链写（影子指标 def）使用。
pub fn patch_plan(args: &Value) -> Result<Value, (String, String)> {
    let gen_id = args.get("gen_id").and_then(Value::as_str).unwrap_or("evolution");
    let body = args.get("body").cloned().filter(|value| !value.is_null());
    let base = args.get("base").and_then(Value::as_u64);

    if let Some(puts) = args.get("puts").and_then(Value::as_array) {
        let ops: Vec<Value> = puts.iter().cloned().map(plan::put_op).collect();
        return Ok(json!({ "$directives": [plan::batch_directive(ops)] }));
    }

    if let Some(append) = args.get("append").and_then(Value::as_object) {
        let section = append.get("section").and_then(Value::as_str).unwrap_or("evidence");
        let entries = append
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let directives = append_plan(gen_id, body, base, section, entries);
        return Ok(json!({ "$directives": directives }));
    }

    if let Some(replace) = args.get("replace").and_then(Value::as_object) {
        let directives = replace_plan(gen_id, body, base, replace);
        return Ok(json!({ "$directives": directives }));
    }

    Ok(json!({ "$directives": [] }))
}

/// 追加计划：条目串 `prev` 后逐条 `put`，再写新 section 索引 + `add_gen`。
fn append_plan(
    gen_id: &str,
    body: Option<Value>,
    base: Option<u64>,
    section: &str,
    mut entries: Vec<Value>,
) -> Vec<Value> {
    let Some(body) = body else {
        return Vec::new();
    };
    let prev_tail = body
        .pointer(&format!("/{section}/tail"))
        .cloned()
        .filter(|value| !value.is_null());
    let old_count = body
        .pointer(&format!("/{section}/count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
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
    if entries.is_empty() {
        return Vec::new();
    }

    let mut ops = Vec::new();
    for entry in &entries {
        ops.push(plan::put_op(entry.clone()));
    }
    let body_index = ops.len();
    // 追加新证据：整体替换该 section 索引，清掉 sweep 写下的 retained/dropped
    // 等窗口字段——否则旧 retained 会把新条目挡在窗口外。
    let new_section = json!({
        "tail": plan::chain_ref(body_index - 1),
        "count": old_count + entries.len() as u64,
    });

    match base {
        Some(seq) => {
            ops.push(plan::put_op(plan::patch_body(vec![plan::replace_op(
                json!([section]),
                new_section,
            )])));
            ops.push(plan::add_gen_op(gen_id, body_index, Some(seq)));
        }
        None => {
            let mut body = body;
            if let Some(object) = body.as_object_mut() {
                object.insert(section.to_string(), new_section);
            }
            ops.push(plan::put_op(body));
            ops.push(plan::add_gen_op(gen_id, body_index, None));
        }
    }
    vec![plan::batch_directive(ops)]
}

/// 替换计划：以给定索引整体替换传入的 section，再写 body/补丁 + `add_gen`。
fn replace_plan(
    gen_id: &str,
    body: Option<Value>,
    base: Option<u64>,
    replace: &Map<String, Value>,
) -> Vec<Value> {
    let Some(body) = body else {
        return Vec::new();
    };
    if replace.is_empty() {
        return Vec::new();
    }
    match base {
        Some(seq) => {
            let patches: Vec<Value> = replace
                .iter()
                .map(|(section, value)| plan::replace_op(json!([section]), value.clone()))
                .collect();
            vec![plan::batch_directive(vec![
                plan::put_op(plan::patch_body(patches)),
                plan::add_gen_op(gen_id, 0, Some(seq)),
            ])]
        }
        None => {
            let mut body = body;
            if let Some(object) = body.as_object_mut() {
                for (section, value) in replace {
                    object.insert(section.clone(), value.clone());
                }
            }
            vec![plan::batch_directive(vec![
                plan::put_op(body),
                plan::add_gen_op(gen_id, 0, None),
            ])]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn read_chain_parses_windows_and_metadata() {
        let bag = json!({
            "trace_entries": [
                {"kind": "trace", "def": "t0", "run": "r1", "workspace_id": "w1", "outcome": "done"}
            ],
            "evolution": {
                "version": 1,
                "trace": {"tail": null, "count": 0},
                "evidence": {"tail": null, "count": 0},
                "data_gen": {"seq": 3, "payload": "a"}
            },
            "refusal_codes": {"pre_unsat": "node"}
        });
        let out = read_chain(&json!({ "bag": bag }));
        assert_eq!(out["trace"][0]["def"], "t0");
        assert_eq!(out["trace"][0]["body"]["run"], "r1");
        assert_eq!(out["base"], 3);
        assert_eq!(out["refusal_codes"]["pre_unsat"], "node");
        assert_eq!(out["body"]["evidence"]["count"], 0);
    }

    #[test]
    fn thresholds_flattens_projection() {
        let out = thresholds(&json!({ "bag": {"thresholds": {"fold_k": 4}} }));
        assert_eq!(out["values"]["fold_k"], 4.0);
    }

    #[test]
    fn hash_supports_modes() {
        let out = hash_method(&json!({"values": ["hello"], "mode": "fnv"})).unwrap();
        assert_eq!(out["hashes"][0], hash::hash64("hello"));
        let kernel = hash_method(&json!({"values": [{"body": {"a": 1}}], "mode": "kernel"})).unwrap();
        assert_eq!(kernel["hashes"][0].as_str().unwrap().len(), 64);
    }

    #[test]
    fn hash_requires_values() {
        assert_eq!(hash_method(&json!({})).unwrap_err().0, "bad_args");
    }

    #[test]
    fn append_plan_chains_entries_and_index() {
        let out = patch_plan(&json!({
            "gen_id": "evolution",
            "body": body(),
            "base": Value::Null,
            "append": {"section": "evidence", "entries": [{"id": "ev-1", "kind": "evidence"}]}
        }))
        .unwrap();
        let ops = out["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0]["op"], "put");
        assert_eq!(ops[0]["args"]["body"]["prev"], Value::Null);
        assert_eq!(ops[1]["args"]["body"]["evidence"]["tail"], json!({"def": {"$n": 0}}));
        assert_eq!(ops[1]["args"]["body"]["evidence"]["count"], 1);
        assert_eq!(ops[2]["op"], "add_gen");
        assert_eq!(ops[2]["args"]["id"], "evolution");
        assert_eq!(ops[2]["args"]["payload"], json!({"$n": 1}));
    }

    #[test]
    fn append_plan_patch_generation_carries_base() {
        let mut body = body();
        body["data_gen"] = json!({"seq": 6, "payload": "a"});
        let out = patch_plan(&json!({
            "body": body,
            "base": 6,
            "append": {"section": "evidence", "entries": [{"id": "ev-1"}]}
        }))
        .unwrap();
        let ops = out["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert!(ops[1]["args"]["body"]["ops"].is_array(), "补丁世代写 patch def");
        assert_eq!(ops[2]["args"]["base"], 6);
    }

    #[test]
    fn append_without_body_emits_no_write() {
        let out = patch_plan(&json!({
            "body": Value::Null,
            "append": {"section": "evidence", "entries": [{"id": "ev-1"}]}
        }))
        .unwrap();
        assert!(out["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn replace_plan_replaces_sections() {
        let out = patch_plan(&json!({
            "body": body(),
            "replace": {"trace": {"tail": null, "count": 1, "retained": [{"def": "t1"}]}}
        }))
        .unwrap();
        let ops = out["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0]["args"]["body"]["trace"]["count"], 1);
        assert_eq!(ops[1]["op"], "add_gen");
    }

    #[test]
    fn puts_plan_has_no_add_gen() {
        let out = patch_plan(&json!({"puts": [{"kind": "shadow_metric"}]})).unwrap();
        let ops = out["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["op"], "put");
    }
}
