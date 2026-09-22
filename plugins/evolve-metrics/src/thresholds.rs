// 数值调参：一律读 #33 loop-policy 的 `thresholds`，本插件不重定义（D14）。
// `thresholds` 在 #33 是链式 tail 条目，投影路径 `["ids","loop-policy","body","thresholds"]` 只给
// `{tail,count}`；实际取值需经 refs 闭包解析。本模块接受多种形状（扁平 map / 链 / 身份投影 / 数组），
// 并给出缺省值——#33 未就位时按缺省跑（契约就位、待 #33）。

use std::collections::BTreeMap;

use serde_json::Value;

/// 阈值表：名字 → 数值。
#[derive(Clone, Debug, Default)]
pub struct Thresholds {
    values: BTreeMap<String, f64>,
}

impl Thresholds {
    pub fn from_bag(bag: &Value) -> Self {
        let mut values = BTreeMap::new();
        if let Some(raw) = bag.get("thresholds") {
            let refs = bag
                .get("thresholds_refs")
                .or_else(|| bag.get("refs"))
                .cloned()
                .unwrap_or(Value::Null);
            collect(raw, &refs, &mut values);
        }
        Self { values }
    }

    pub fn from_map(map: BTreeMap<String, f64>) -> Self {
        Self { values: map }
    }

    /// 浮点阈值（缺省 / 非法类型回落缺省）。
    pub fn number(&self, name: &str, default: f64) -> f64 {
        self.values.get(name).copied().unwrap_or(default)
    }

    /// 正整数阈值。
    pub fn count(&self, name: &str, default: usize) -> usize {
        self.values
            .get(name)
            .filter(|value| **value >= 0.0 && value.is_finite())
            .map(|value| *value as usize)
            .unwrap_or(default)
    }
}

/// 从任意形状收集阈值：扁平 map / `{tail,count}` 链 / 身份投影 / 条目数组。
fn collect(raw: &Value, refs: &Value, out: &mut BTreeMap<String, f64>) {
    if let Some(object) = raw.as_object() {
        // 身份投影：{body, refs, …}
        if let Some(body) = object.get("body") {
            let inner_refs = object.get("refs").unwrap_or(refs);
            collect(body, inner_refs, out);
            return;
        }
        // 链式条目：{name, value, prev}——按名收值，不再深入 `prev`（由 collect_chain 走链）。
        if let Some(name) = object.get("name").and_then(Value::as_str) {
            if let Some(value) = object.get("value") {
                insert(name, value, out);
            }
            return;
        }
        // 阈值容器：{thresholds: …} 或 {tail,count}
        if let Some(inner) = object.get("thresholds") {
            collect(inner, refs, out);
            return;
        }
        if object.contains_key("tail") {
            collect_chain(raw, refs, out);
            return;
        }
        // 扁平 map：数字值直接收；对象值（如 {value: n}）也收。
        for (name, value) in object {
            insert(name, value, out);
        }
        return;
    }
    if let Some(items) = raw.as_array() {
        for item in items {
            collect(item, refs, out);
        }
    }
}

/// 链式 tail：从 tail.def 沿 `prev` 走，逐条 `{name, value}` 收。
fn collect_chain(container: &Value, refs: &Value, out: &mut BTreeMap<String, f64>) {
    let Some(map) = refs.as_object() else {
        return;
    };
    let mut cursor = container
        .get("tail")
        .and_then(|tail| tail.get("def"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut guard = 0;
    while let Some(hash) = cursor {
        guard += 1;
        if guard > 100_000 {
            break;
        }
        let Some(entry) = map.get(&hash) else {
            break;
        };
        collect(entry, refs, out);
        cursor = entry
            .get("prev")
            .and_then(|prev| prev.get("def"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
}

fn insert(name: &str, value: &Value, out: &mut BTreeMap<String, f64>) {
    if let Some(number) = value.as_f64() {
        out.insert(name.to_string(), number);
        return;
    }
    if let Some(inner) = value.get("value").and_then(Value::as_f64) {
        out.insert(name.to_string(), inner);
        return;
    }
    if let Some(inner) = value.get("name").and_then(Value::as_str) {
        if let Some(number) = value.get("value").and_then(Value::as_f64) {
            out.insert(inner.to_string(), number);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flat_map_is_read() {
        let bag = json!({"thresholds": {"failure_cluster_n": 5, "fold_k": 2}});
        let thresholds = Thresholds::from_bag(&bag);
        assert_eq!(thresholds.count("failure_cluster_n", 3), 5);
        assert_eq!(thresholds.count("fold_k", 3), 2);
        assert_eq!(thresholds.count("missing", 7), 7);
    }

    #[test]
    fn identity_projection_body_is_read() {
        let bag = json!({
            "thresholds": {
                "active": "x",
                "body": {"version": 1, "thresholds": {"failure_cluster_n": 4}},
                "refs": {}
            }
        });
        let thresholds = Thresholds::from_bag(&bag);
        assert_eq!(thresholds.count("failure_cluster_n", 3), 4);
    }

    #[test]
    fn chain_tail_is_resolved_via_refs() {
        let bag = json!({
            "thresholds": {"tail": {"def": "h1"}, "count": 2},
            "thresholds_refs": {
                "h1": {"name": "fold_k", "value": 4, "prev": {"def": "h0"}},
                "h0": {"name": "min_workspaces", "value": 3, "prev": null}
            }
        });
        let thresholds = Thresholds::from_bag(&bag);
        assert_eq!(thresholds.count("fold_k", 3), 4);
        assert_eq!(thresholds.count("min_workspaces", 2), 3);
    }

    #[test]
    fn invalid_value_falls_back_to_default() {
        let bag = json!({"thresholds": {"fold_k": "three"}});
        let thresholds = Thresholds::from_bag(&bag);
        assert_eq!(thresholds.count("fold_k", 3), 3);
    }
}
