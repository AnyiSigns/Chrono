// bag 解析：把调用方入口 term 注入的投影片段归一成纯计算可用的形状。
// 服务不读投影，只认 bag 里的值：查询 / L1 goal / 工作区 / memory-store 投影 / 去重集 / 时钟 / 模型连接。

use std::collections::BTreeSet;

use serde_json::Value;

/// 基础查询：顶层 `query`（recall 节点路径与工具路径都以它传入）。
pub fn query_of(bag: &Value) -> String {
    bag.get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// L1 goal / 摘要：顶层 `goal`，或 `bag.l1.goal`。
pub fn goal_of(bag: &Value) -> String {
    if let Some(goal) = bag.get("goal").and_then(Value::as_str) {
        if !goal.is_empty() {
            return goal.to_string();
        }
    }
    bag.get("l1")
        .and_then(|l1| l1.get("goal"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 当前工作区 id：顶层 `workspace`。
pub fn workspace_of(bag: &Value) -> String {
    bag.get("workspace")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// memory-store 投影 `{body, refs}`：优先 `bag.memory`，其次 `memory_body` / `memory_refs`，
/// 再次顶层 `body` / `refs`。缺失回 `Value::Null`。
pub fn memory_parts(bag: &Value) -> (Value, Value) {
    if let Some(memory) = bag.get("memory").and_then(Value::as_object) {
        let body = memory.get("body").cloned().unwrap_or(Value::Null);
        let refs = memory.get("refs").cloned().unwrap_or(Value::Null);
        return (body, refs);
    }
    if bag.get("memory_body").is_some() || bag.get("memory_refs").is_some() {
        let body = bag.get("memory_body").cloned().unwrap_or(Value::Null);
        let refs = bag.get("memory_refs").cloned().unwrap_or(Value::Null);
        return (body, refs);
    }
    (
        bag.get("body").cloned().unwrap_or(Value::Null),
        bag.get("refs").cloned().unwrap_or(Value::Null),
    )
}

/// 上下文去重集：`bag.dedup_set` 的字符串项；非字符串忽略。
pub fn dedup_set(bag: &Value) -> BTreeSet<String> {
    bag.get("dedup_set")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// `now`：bag 优先，其次调用帧 `env.now`；都没有则 `None`。服务不取时间。
pub fn now_of(bag: &Value, env: &Value) -> Option<f64> {
    bag.get("now")
        .filter(|value| !value.is_null())
        .or_else(|| env.get("now").filter(|value| !value.is_null()))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

/// 模型连接实例（多查询 / 语义重排时 eff model.chat 用）；缺失回 `Null`。
pub fn model_config(bag: &Value) -> Value {
    bag.get("model_config").cloned().unwrap_or(Value::Null)
}

/// 对象字符串字段（缺失 / 非字符串 → 空串）。
pub fn string_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn query_and_goal_and_workspace() {
        let bag = json!({"query": "find", "goal": "ship it", "workspace": "w1"});
        assert_eq!(query_of(&bag), "find");
        assert_eq!(goal_of(&bag), "ship it");
        assert_eq!(workspace_of(&bag), "w1");
    }

    #[test]
    fn goal_falls_back_to_l1() {
        assert_eq!(goal_of(&json!({"l1": {"goal": "g"}})), "g");
    }

    #[test]
    fn memory_prefers_nested_shape() {
        let bag = json!({"memory": {"body": {"count": 1}, "refs": {"h": {}}}});
        let (body, refs) = memory_parts(&bag);
        assert_eq!(body["count"], 1);
        assert!(refs.get("h").is_some());
    }

    #[test]
    fn memory_accepts_flat_shape() {
        let bag = json!({"body": {"count": 2}, "refs": {}});
        let (body, _) = memory_parts(&bag);
        assert_eq!(body["count"], 2);
    }

    #[test]
    fn missing_memory_is_null() {
        let (body, refs) = memory_parts(&json!({}));
        assert!(body.is_null() && refs.is_null());
    }

    #[test]
    fn dedup_set_ignores_non_strings() {
        let set = dedup_set(&json!({"dedup_set": ["a", 3, "b"]}));
        assert!(set.contains("a") && set.contains("b"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn now_prefers_bag_then_env() {
        assert_eq!(now_of(&json!({"now": 7}), &json!({"now": 9})), Some(7.0));
        assert_eq!(now_of(&json!({}), &json!({"now": 9})), Some(9.0));
        assert_eq!(now_of(&json!({}), &json!({})), None);
    }
}
