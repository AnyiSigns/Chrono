// bag 解析：把调用方（#33 路径）或宿主 periodic.reads（周期路径）注入的投影片段，
// 归一成纯计算可用的形状。服务不读投影，只认 bag 里的值。

use std::collections::BTreeMap;

use serde_json::Value;

/// 一条轨迹条目：`def` 是条目 def 哈希（引用溯源用），`body` 是条目本体。
#[derive(Clone, Debug)]
pub struct TraceRef {
    pub def: Option<String>,
    pub body: Value,
}

impl TraceRef {
    pub fn workspace_id(&self) -> String {
        string_of(&self.body, "workspace_id")
    }

    pub fn outcome(&self) -> String {
        string_of(&self.body, "outcome")
    }

    pub fn run(&self) -> String {
        string_of(&self.body, "run")
    }

    pub fn id(&self) -> String {
        string_of(&self.body, "id")
    }

    pub fn steps(&self) -> &[Value] {
        self.body
            .get("steps")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn refused_at(&self) -> Option<&Value> {
        self.body.get("refused_at").filter(|value| !value.is_null())
    }

    pub fn def_ref(&self) -> Option<Value> {
        self.def.as_ref().map(|hash| serde_json::json!({ "def": hash }))
    }
}

/// 轨迹窗口：按链序「最旧 → 最新」。接受条目数组 / `{entries}` / 身份投影 / evolution body / 链。
pub fn trace_entries(bag: &Value) -> Vec<TraceRef> {
    if let Some(items) = bag.get("trace_entries").and_then(Value::as_array) {
        return from_array(items);
    }
    let Some(trace) = bag.get("trace") else {
        return Vec::new();
    };
    if let Some(items) = trace.as_array() {
        return from_array(items);
    }
    let Some(object) = trace.as_object() else {
        return Vec::new();
    };
    if let Some(items) = object.get("entries").and_then(Value::as_array) {
        return from_array(items);
    }
    let (body, refs) = if object.contains_key("body") {
        (
            object.get("body").cloned().unwrap_or(Value::Null),
            object.get("refs").cloned().unwrap_or(Value::Null),
        )
    } else {
        (
            trace.clone(),
            bag.get("refs")
                .or_else(|| bag.get("trace_refs"))
                .cloned()
                .unwrap_or(Value::Null),
        )
    };
    if let Some(items) = body.as_array() {
        return from_array(items);
    }
    if let Some(items) = body.get("trace_entries").and_then(Value::as_array) {
        return from_array(items);
    }
    let refs = if refs.is_null() {
        bag.get("refs").cloned().unwrap_or(Value::Null)
    } else {
        refs
    };
    chain_field(&body, &refs, "trace")
}

fn from_array(items: &[Value]) -> Vec<TraceRef> {
    items
        .iter()
        .map(|item| {
            // 包装形状 `{def, body}`：def 是条目哈希、body 是条目本体。
            if let Some(body) = item.get("body") {
                if item.get("def").is_some() {
                    return TraceRef {
                        def: item.get("def").and_then(Value::as_str).map(str::to_string),
                        body: body.clone(),
                    };
                }
            }
            // 平铺形状：条目本体自带 `def` 兄弟字段（#33 内存路径）或纯本体。
            TraceRef {
                def: item.get("def").and_then(Value::as_str).map(str::to_string),
                body: item.clone(),
            }
        })
        .collect()
}

/// evidence 窗口：与 trace 同源（evolution 投影 body + refs），沿 `body.evidence` 链。
/// 显式 `evidence_entries` 数组优先；否则取 evolution 投影（`{body,refs}` 或 body 本体）走链。
pub fn evidence_entries(bag: &Value) -> Vec<TraceRef> {
    if let Some(items) = bag.get("evidence_entries").and_then(Value::as_array) {
        return from_array(items);
    }
    let (body, refs) = evolution_projection(bag);
    chain_field(&body, &refs, "evidence")
}

/// evolution 投影的 (body, refs)：接受 `{body,refs}` 包装或 body 本体（refs 在顶层）。
fn evolution_projection(bag: &Value) -> (Value, Value) {
    for key in ["evolution", "trace"] {
        if let Some(object) = bag.get(key).and_then(Value::as_object) {
            if object.contains_key("body") {
                return (
                    object.get("body").cloned().unwrap_or(Value::Null),
                    object.get("refs").cloned().unwrap_or(Value::Null),
                );
            }
        }
    }
    let body = bag
        .get("evolution")
        .or_else(|| bag.get("trace"))
        .cloned()
        .unwrap_or(Value::Null);
    let refs = bag
        .get("refs")
        .or_else(|| bag.get("trace_refs"))
        .cloned()
        .unwrap_or(Value::Null);
    (body, refs)
}

/// 沿 `body.<field>.tail` + refs 闭包回溯，返回最旧 → 最新。
/// `sweep` 写出的新 body 带 `<field>.retained`（保留窗口的显式列表）：它是权威边界，
/// 优先按它取窗口，避免仍沿 `prev` 走回被丢弃条目导致窗口不缩、`swept` 每拍重复。
fn chain_field(body: &Value, refs: &Value, field: &str) -> Vec<TraceRef> {
    let Some(section) = body.get(field) else {
        return Vec::new();
    };
    if let Some(items) = section.as_array() {
        return from_array(items);
    }
    if let Some(retained) = section.get("retained").and_then(Value::as_array) {
        let map = refs.as_object();
        return retained
            .iter()
            .filter_map(|item| {
                let hash = item.get("def").and_then(Value::as_str)?;
                let entry = map?.get(hash)?;
                Some(TraceRef {
                    def: Some(hash.to_string()),
                    body: entry.clone(),
                })
            })
            .collect();
    }
    let Some(map) = refs.as_object() else {
        return Vec::new();
    };
    let mut cursor = section
        .get("tail")
        .and_then(|tail| tail.get("def"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut out = Vec::new();
    let mut guard = 0;
    while let Some(hash) = cursor {
        guard += 1;
        if guard > 100_000 {
            break;
        }
        let Some(entry) = map.get(&hash) else {
            break;
        };
        cursor = entry
            .get("prev")
            .and_then(|prev| prev.get("def"))
            .and_then(Value::as_str)
            .map(str::to_string);
        out.push(TraceRef {
            def: Some(hash.to_string()),
            body: entry.clone(),
        });
    }
    out.reverse();
    out
}

/// 当前 evolution body（写计划需保留 evidence / proposals / verdicts 链头）。
/// 只认四类 tail 形状（`trace` + `evidence`）；投影 `body` 无数据世代时会回落代码世代 commit def
/// body（`{tree,meta}`），那不是台账 body，须拒之以免写坏身份数据。
/// 入口切片会把 `refs` 闭包并进同一层（见 chat `ledgerSliceOf`）；body 是要落账的，
/// 必须剔除 `refs`，否则每回合把整份闭包写回 body，台账体积无界增长。
pub fn evolution_body(bag: &Value) -> Option<Value> {
    for key in ["evolution", "trace"] {
        if let Some(value) = bag.get(key) {
            if let Some(body) = value.get("body") {
                if is_evolution_body(body) {
                    return Some(body.clone());
                }
            }
            if is_evolution_body(value) {
                return Some(without_refs(value.clone()));
            }
        }
    }
    bag.get("evolution_body")
        .filter(|value| is_evolution_body(value))
        .map(|value| without_refs(value.clone()))
}

/// 剔除入口切片并入的 `refs` 闭包与投影元数据 `data_gen`（世界写入的 body 不得含它们）。
fn without_refs(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("refs");
        object.remove("data_gen");
    }
    value
}

/// 补丁世代基础下标：投影切片 `evolution.data_gen.seq`（或 `trace.data_gen.seq` / 顶层 `data_gen.seq`）。
/// 无数据世代 → None（写整份世代，向后兼容）。
pub fn base_of(bag: &Value) -> Option<u64> {
    for key in ["evolution", "trace"] {
        if let Some(seq) = bag
            .get(key)
            .and_then(|value| value.get("data_gen"))
            .and_then(|data_gen| data_gen.get("seq"))
            .and_then(Value::as_u64)
        {
            return Some(seq);
        }
    }
    bag.get("data_gen")
        .and_then(|data_gen| data_gen.get("seq"))
        .and_then(Value::as_u64)
}

fn is_evolution_body(value: &Value) -> bool {
    value.is_object() && value.get("trace").is_some() && value.get("evidence").is_some()
}

/// 候选新图（shadow）：`{def:hash}` 或图 body 或节点数组。
pub fn graph(bag: &Value) -> Value {
    bag.get("graph").cloned().unwrap_or(Value::Null)
}

/// 投影引用闭包 `{hash: body}`：从 trace / verdicts 身份投影或顶层 `refs` 取。
pub fn refs_map(bag: &Value) -> Value {
    for key in ["trace", "verdicts", "evolution"] {
        if let Some(refs) = bag.get(key).and_then(|value| value.get("refs")) {
            if refs.is_object() {
                return refs.clone();
            }
        }
    }
    bag.get("refs")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or(Value::Null)
}

/// `now`：bag 优先，其次调用帧 `env.now`（宿主固定时钟），都没有则 null。服务不取时间。
pub fn now_of(bag: &Value, fallback: &Value) -> Value {
    if let Some(now) = bag.get("now") {
        if !now.is_null() {
            return now.clone();
        }
    }
    fallback.clone()
}

/// 可选拒绝码 → 归因映射（供 step.refusal 归因；缺省只用 trace.refused_at）。
pub fn refusal_codes(bag: &Value) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(map) = bag.get("refusal_codes").and_then(Value::as_object) {
        for (code, attribution) in map {
            if let Some(text) = attribution.as_str() {
                out.insert(code.clone(), text.to_string());
            } else if let Some(text) = attribution.get("attributable_to").and_then(Value::as_str) {
                out.insert(code.clone(), text.to_string());
            }
        }
    }
    out
}

/// 对象字符串字段（缺失 / 非字符串 → 空串）。
pub fn string_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 对象整数字段（缺失 / 非整数 → 缺省）。
pub fn uint_of(value: &Value, key: &str, default: u64) -> u64 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(default)
}

/// 对象浮点字段（缺失 / 非数字 → 缺省）。
pub fn float_of(value: &Value, key: &str, default: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chain_walk_is_oldest_to_newest() {
        let bag = json!({
            "trace": {"body": {"trace": {"tail": {"def": "t2"}, "count": 3}}, "refs": {
                "t2": {"kind": "trace", "run": "r3", "prev": {"def": "t1"}},
                "t1": {"kind": "trace", "run": "r2", "prev": {"def": "t0"}},
                "t0": {"kind": "trace", "run": "r1", "prev": null}
            }}
        });
        let entries = trace_entries(&bag);
        let runs: Vec<String> = entries.iter().map(TraceRef::run).collect();
        assert_eq!(runs, vec!["r1", "r2", "r3"]);
        assert_eq!(entries[2].def.as_deref(), Some("t2"));
    }

    #[test]
    fn evidence_chain_walk_is_oldest_to_newest() {
        let bag = json!({
            "evolution": {
                "trace": {"tail": null, "count": 0},
                "evidence": {"tail": {"def": "e1"}, "count": 2}
            },
            "refs": {
                "e1": {"kind": "evidence", "id": "ev-1", "prev": {"def": "e0"}},
                "e0": {"kind": "evidence", "id": "ev-0", "prev": null}
            }
        });
        let entries = evidence_entries(&bag);
        let ids: Vec<String> = entries.iter().map(TraceRef::id).collect();
        assert_eq!(ids, vec!["ev-0", "ev-1"]);
        assert_eq!(entries[1].def.as_deref(), Some("e1"));
    }

    #[test]
    fn retained_list_bounds_window_and_ignores_dropped_prev() {
        // sweep 写出的 body：tail 指向最新保留项，但 prev 链仍回到被丢弃轨迹；
        // `retained` 是权威边界，窗口只含保留项。
        let bag = json!({
            "trace": {"body": {"trace": {"tail": {"def": "t2"}, "count": 2,
                "retained": [{"def": "t1"}, {"def": "t2"}]}}, "refs": {
                "t2": {"kind": "trace", "run": "r2", "prev": {"def": "t1"}},
                "t1": {"kind": "trace", "run": "r1", "prev": {"def": "t0"}},
                "t0": {"kind": "trace", "run": "r0", "prev": null}
            }}
        });
        let entries = trace_entries(&bag);
        let runs: Vec<String> = entries.iter().map(TraceRef::run).collect();
        assert_eq!(runs, vec!["r1", "r2"]);
        assert_eq!(entries[0].def.as_deref(), Some("t1"));
    }

    #[test]
    fn empty_retained_list_is_authoritative() {
        // 全部丢弃：retained 为空即空窗口，不回落 prev 链。
        let bag = json!({
            "trace": {"body": {"trace": {"tail": {"def": "t2"}, "count": 0, "retained": []}}, "refs": {
                "t2": {"kind": "trace", "run": "r2", "prev": {"def": "t1"}},
                "t1": {"kind": "trace", "run": "r1", "prev": null}
            }}
        });
        assert!(trace_entries(&bag).is_empty());
    }

    #[test]
    fn explicit_entries_are_used() {
        let bag = json!({"trace_entries": [
            {"kind": "trace", "run": "a", "outcome": "refused"},
            {"kind": "trace", "run": "b", "outcome": "done"}
        ]});
        let entries = trace_entries(&bag);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].outcome(), "refused");
        assert_eq!(entries[1].run(), "b");
    }

    #[test]
    fn empty_bag_yields_empty() {
        assert!(trace_entries(&json!({})).is_empty());
        assert!(trace_entries(&json!({"trace": null})).is_empty());
    }

    #[test]
    fn evolution_body_from_projection() {
        let bag = json!({"trace": {"body": {
            "version": 1,
            "trace": {"tail": null, "count": 0},
            "evidence": {"tail": null, "count": 0}
        }}});
        let body = evolution_body(&bag).unwrap();
        assert_eq!(body["version"], 1);
    }

    #[test]
    fn code_gen_body_is_not_an_evolution_body() {
        // 投影 body 无数据世代时回落代码世代 commit def body（{tree,meta}），不得当台账 body。
        let bag = json!({"trace": {"body": {"tree": "abc", "meta": {"name": "evolution"}}}});
        assert!(evolution_body(&bag).is_none());
    }

    #[test]
    fn evolution_body_strips_merged_refs() {
        // 入口切片把 refs 闭包并进同一层；body 落账前必须剔除，否则每回合把闭包写回、无界增长。
        let bag = json!({"evolution": {
            "version": 1,
            "trace": {"tail": null, "count": 0},
            "evidence": {"tail": null, "count": 0},
            "refs": {"a": {"x": 1}}
        }});
        let body = evolution_body(&bag).unwrap();
        assert_eq!(body["version"], 1);
        assert!(body.get("refs").is_none());
    }

    #[test]
    fn base_of_reads_evolution_data_gen() {
        let bag = json!({"evolution": {"data_gen": {"seq": 4, "payload": "x"}}});
        assert_eq!(base_of(&bag), Some(4));
        assert_eq!(base_of(&json!({})), None);
        assert_eq!(base_of(&json!({"evolution": {"data_gen": {"seq": null}}})), None);
    }

    #[test]
    fn evolution_body_strips_data_gen() {
        let bag = json!({"evolution": {
            "version": 1,
            "trace": {"tail": null, "count": 0},
            "evidence": {"tail": null, "count": 0},
            "data_gen": {"seq": 2, "payload": "y"}
        }});
        let body = evolution_body(&bag).unwrap();
        assert!(body.get("data_gen").is_none());
        assert_eq!(body["version"], 1);
    }

    #[test]
    fn now_prefers_bag_then_env() {
        assert_eq!(now_of(&json!({"now": 7}), &json!(9)), json!(7));
        assert_eq!(now_of(&json!({}), &json!(9)), json!(9));
    }
}
