// 纯数值：L2 归一、点积 / 余弦、chunk 命中归并、条目分组、MMR 贪心重排。
// 向量由向量化服务输出（已 L2 归一），dim 一致时点积即余弦；一切排序带确定 tie-break，
// 同输入同输出（模型项关闭时逐字节可回放）。

use std::collections::BTreeMap;

/// 一条 chunk 级命中（来自索引检索）。
#[derive(Clone, Debug, PartialEq)]
pub struct ChunkHit {
    pub entry_hash: String,
    pub chunk_index: u64,
    pub score: f64,
}

/// 按条目归并后的候选（同条目取最高分 chunk）。
#[derive(Clone, Debug, PartialEq)]
pub struct EntryScore {
    pub entry_hash: String,
    pub score: f64,
    pub chunk_index: u64,
}

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

/// 命中排序：score 降序，同分按 entry_hash、chunk_index 升序（确定）。
pub fn rank_chunks(hits: &mut [ChunkHit]) {
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.entry_hash.cmp(&right.entry_hash))
            .then_with(|| left.chunk_index.cmp(&right.chunk_index))
    });
}

/// 跨查询归并：同 (entry_hash, chunk_index) 取最高分，再按确定序排序。
pub fn merge_chunk_hits(groups: &[Vec<ChunkHit>]) -> Vec<ChunkHit> {
    let mut best: BTreeMap<(String, u64), f64> = BTreeMap::new();
    for group in groups {
        for hit in group {
            let key = (hit.entry_hash.clone(), hit.chunk_index);
            best.entry(key)
                .and_modify(|score| {
                    if hit.score > *score {
                        *score = hit.score;
                    }
                })
                .or_insert(hit.score);
        }
    }
    let mut merged: Vec<ChunkHit> = best
        .into_iter()
        .map(|((entry_hash, chunk_index), score)| ChunkHit {
            entry_hash,
            chunk_index,
            score,
        })
        .collect();
    rank_chunks(&mut merged);
    merged
}

/// 同条目取最高分（记录最佳 chunk），按 score 降序、entry_hash 升序确定排序。
pub fn group_by_entry(hits: &[ChunkHit]) -> Vec<EntryScore> {
    let mut best: BTreeMap<String, EntryScore> = BTreeMap::new();
    for hit in hits {
        match best.get(&hit.entry_hash) {
            Some(existing) if existing.score >= hit.score => {}
            _ => {
                best.insert(
                    hit.entry_hash.clone(),
                    EntryScore {
                        entry_hash: hit.entry_hash.clone(),
                        score: hit.score,
                        chunk_index: hit.chunk_index,
                    },
                );
            }
        }
    }
    let mut entries: Vec<EntryScore> = best.into_values().collect();
    entries.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.entry_hash.cmp(&right.entry_hash))
    });
    entries
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

    fn hit(entry: &str, chunk: u64, score: f64) -> ChunkHit {
        ChunkHit {
            entry_hash: entry.to_string(),
            chunk_index: chunk,
            score,
        }
    }

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
    fn merge_takes_max_per_chunk() {
        let groups = vec![
            vec![hit("e1", 0, 0.5), hit("e2", 0, 0.9)],
            vec![hit("e1", 0, 0.7), hit("e2", 0, 0.3)],
        ];
        let merged = merge_chunk_hits(&groups);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].entry_hash, "e2");
        assert!((merged[0].score - 0.9).abs() < 1e-12);
        assert!((merged[1].score - 0.7).abs() < 1e-12);
    }

    #[test]
    fn group_takes_best_chunk_per_entry() {
        let hits = vec![hit("e2", 0, 0.9), hit("e2", 1, 0.8), hit("e1", 0, 0.5)];
        let grouped = group_by_entry(&hits);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].entry_hash, "e2");
        assert_eq!(grouped[0].chunk_index, 0);
        assert!((grouped[0].score - 0.9).abs() < 1e-12);
        assert_eq!(grouped[1].entry_hash, "e1");
    }

    #[test]
    fn tie_break_is_lexicographic() {
        let mut hits = vec![hit("b", 0, 0.5), hit("a", 0, 0.5)];
        rank_chunks(&mut hits);
        assert_eq!(hits[0].entry_hash, "a");
        assert_eq!(hits[1].entry_hash, "b");
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
