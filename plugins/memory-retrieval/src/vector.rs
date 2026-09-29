// 纯数值：chunk 命中归并、条目分组。
// 一切排序带确定 tie-break，同输入同输出（模型项关闭时逐字节可回放）。
// 余弦 / MMR 重排已下沉 `rerank`，本模块只留检索侧的 chunk 归并与条目分组。

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
}
