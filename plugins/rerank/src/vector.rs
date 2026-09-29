// 纯数值：L2 归一、点积 / 余弦、MMR 贪心重排。
// 向量由向量化服务输出（已 L2 归一），dim 一致时点积即余弦；排序带确定 tie-break，
// 同输入同输出（模型项关闭时逐字节可回放）。

/// L2 归一；零向量 / 非有限范数回零向量（不产生 NaN）。
pub fn normalize(vector: &[f64]) -> Vec<f64> {
    let sum: f64 = vector.iter().map(|value| value * value).sum();
    let norm = sum.sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return vec![0.0; vector.len()];
    }
    vector.iter().map(|value| value / norm).collect()
}

/// 点积（dim 已 L2 归一 ⇒ 即余弦）；长度不一致取较短者。
pub fn dot(left: &[f64], right: &[f64]) -> f64 {
    left.iter().zip(right.iter()).map(|(a, b)| a * b).sum()
}

/// 余弦相似度；任一侧零向量回 0，避免 NaN。
pub fn cosine(left: &[f64], right: &[f64]) -> f64 {
    let unit_left = normalize(left);
    let unit_right = normalize(right);
    let value = dot(&unit_left, &unit_right);
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// MMR 候选：相关度 + 条目向量（用于两两冗余度）。
#[derive(Clone, Debug)]
pub struct MmrItem {
    pub key: String,
    pub relevance: f64,
    pub vector: Vec<f64>,
}

/// MMR 贪心重排，返回 key 顺序；`lambda` = 相关度权重（1.0 = 纯相关度）。
/// 选择规则：`lambda·rel(c) − (1−lambda)·max_{s∈已选} cos(c, s)`；平手按 key 升序确定。
pub fn mmr_order(items: &[MmrItem], lambda: f64) -> Vec<String> {
    let weight = lambda.clamp(0.0, 1.0);
    let mut remaining: Vec<&MmrItem> = items.iter().collect();
    let mut selected: Vec<&MmrItem> = Vec::new();
    let mut order: Vec<String> = Vec::new();
    while !remaining.is_empty() {
        let mut best: Option<(&MmrItem, f64)> = None;
        for candidate in remaining.iter().copied() {
            let redundancy = selected
                .iter()
                .map(|chosen| cosine(&candidate.vector, &chosen.vector))
                .fold(f64::NEG_INFINITY, f64::max);
            let redundancy = if redundancy == f64::NEG_INFINITY {
                0.0
            } else {
                redundancy
            };
            let value = weight * candidate.relevance - (1.0 - weight) * redundancy;
            best = match best {
                None => Some((candidate, value)),
                Some((current, current_value)) => {
                    let better = value > current_value
                        || (value == current_value && candidate.key < current.key);
                    if better {
                        Some((candidate, value))
                    } else {
                        Some((current, current_value))
                    }
                }
            };
        }
        let (chosen, _) = best.expect("remaining is non-empty");
        order.push(chosen.key.clone());
        selected.push(chosen);
        remaining.retain(|item| item.key != chosen.key);
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_cosine() {
        let unit = normalize(&[3.0, 4.0]);
        assert!((unit[0] - 0.6).abs() < 1e-12);
        assert!((unit[1] - 0.8).abs() < 1e-12);
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-12);
        assert!((cosine(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-12);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 0.0]), 0.0);
    }

    #[test]
    fn mmr_pure_relevance_keeps_score_order() {
        let items = vec![
            MmrItem {
                key: "a".into(),
                relevance: 0.9,
                vector: vec![1.0, 0.0],
            },
            MmrItem {
                key: "b".into(),
                relevance: 0.5,
                vector: vec![0.0, 1.0],
            },
        ];
        assert_eq!(mmr_order(&items, 1.0), vec!["a", "b"]);
    }

    #[test]
    fn mmr_pure_diversity_penalizes_redundancy() {
        // a 与 b 近乎重复且相关度高；c 相关度略低但独立。
        let items = vec![
            MmrItem {
                key: "a".into(),
                relevance: 0.9,
                vector: vec![1.0, 0.0],
            },
            MmrItem {
                key: "b".into(),
                relevance: 0.89,
                vector: vec![1.0, 0.0],
            },
            MmrItem {
                key: "c".into(),
                relevance: 0.8,
                vector: vec![0.0, 1.0],
            },
        ];
        assert_eq!(mmr_order(&items, 0.0), vec!["a", "c", "b"]);
    }

    #[test]
    fn mmr_tie_break_is_deterministic() {
        let items = vec![
            MmrItem {
                key: "z".into(),
                relevance: 1.0,
                vector: vec![],
            },
            MmrItem {
                key: "y".into(),
                relevance: 1.0,
                vector: vec![],
            },
        ];
        assert_eq!(mmr_order(&items, 1.0), vec!["y", "z"]);
    }
}
