// bag 解析：把调用方入口 term 注入的值归一成纯计算可用的形状。
// 服务不读投影，只认 bag 里的值：查询 / L1 goal / 工作区 / 去重集 / 时钟 / 模型连接；
// L3 条目与索引由 `memory-store` owner 自持，本服务经 `memory` pin 反向调用，不经 bag 传切片。

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
