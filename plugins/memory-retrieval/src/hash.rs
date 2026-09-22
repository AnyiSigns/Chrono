// 确定性内容哈希：FNV-1a 64 位，输出 16 位小写 hex。
// 用于查询向量缓存键——只求「同输入同输出」，不追求密码学强度。
// serde_json 缺省 `Map` 是 BTreeMap，`to_string` 键序确定，故 canonical 序列化可复现。

use serde_json::Value;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 位哈希。
pub fn hash64(text: &str) -> String {
    let mut hash = FNV_OFFSET;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

/// 确定性 JSON 序列化（serde_json 缺省键序排序）。
pub fn canonical(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// 值的确定性内容哈希。
pub fn content_hash(value: &Value) -> String {
    hash64(&canonical(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hash64_is_stable_and_hex() {
        let first = hash64("hello");
        assert_eq!(first, hash64("hello"));
        assert_eq!(first.len(), 16);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, hash64("hellp"));
    }

    #[test]
    fn canonical_ignores_insertion_order() {
        let left = json!({"b": 1, "a": 2});
        let right = json!({"a": 2, "b": 1});
        assert_eq!(canonical(&left), canonical(&right));
        assert_eq!(content_hash(&left), content_hash(&right));
    }
}
