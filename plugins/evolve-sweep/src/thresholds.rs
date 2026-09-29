// 阈值访问面：解析住 `evolve-ledger.thresholds`，本插件只持有扁平 `{name: number}` 并取值。
// 本插件不重定义任何数值调参（全部读 loop-policy `thresholds`，经台账提供方归一）。

use std::collections::BTreeMap;

use serde_json::Value;

/// 阈值表：名字 → 数值。
#[derive(Clone, Debug, Default)]
pub struct Thresholds {
    values: BTreeMap<String, f64>,
}

impl Thresholds {
    /// 直接由扁平表构造（单测 / 内部）。
    pub fn from_map(values: BTreeMap<String, f64>) -> Self {
        Self { values }
    }

    /// 从 `evolve-ledger.thresholds` 回包的 `{values: {name: number}}` 取值。
    pub fn from_values(value: &Value) -> Self {
        let mut values = BTreeMap::new();
        if let Some(map) = value.as_object() {
            for (name, raw) in map {
                if let Some(number) = raw.as_f64() {
                    values.insert(name.clone(), number);
                }
            }
        }
        Self { values }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_are_read_with_defaults() {
        let thresholds = Thresholds::from_values(&json!({"trace_retention_rounds": 1.0}));
        assert_eq!(thresholds.count("trace_retention_rounds", 50), 1);
        assert_eq!(thresholds.count("missing", 7), 7);
    }
}
