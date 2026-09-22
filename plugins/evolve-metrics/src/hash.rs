// 确定性内容哈希：FNV-1a 64 位，输出 16 位小写 hex。
// 用于证据 id / ③ 缓存键——只求「同输入同输出」，不追求密码学强度。
// `kernel_hash` 另按内核 `H` 口径（sha256(utf8(canonicalJson(v)))）算 def 键，
// 供 `shadow` 的 `metric_id` 与投影 `{"def":hash}` 标记对齐；纯 Rust 自实现，无外部依赖。
// serde_json 缺省 `Map` 是 BTreeMap，`to_string` 键序确定，故 canonical 序列化可复现。

use serde_json::Value;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

const SHA256_INITIAL: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_ROUND: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

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

/// 内核口径的规范序列化：键升序、整数与整数值浮点输出十进制整数、其余同 JSON。
/// 与 `loop-policy` / 内核 `value.ts` 的 `canonicalJson` 同口径，保证 def 键可对拍。
pub fn canonical_kernel(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

/// 内核 `H`：`sha256(utf8(canonicalJson(v)))`，64 位小写 hex。`put` 的 def 键 = `H({body})`。
pub fn kernel_hash(value: &Value) -> String {
    sha256_hex(canonical_kernel(value).as_bytes())
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => {
            out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string()));
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // serde_json 缺省 Map 是 BTreeMap：键已升序。
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                write_canonical(item, out);
            }
            out.push('}');
        }
    }
}

/// JS `String(Number)` 的常用子集：整数直出、整数值浮点去尾零，其余走最短往返表示。
fn number_text(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    let value = number.as_f64().unwrap_or(0.0);
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    format!("{value}")
}

/// SHA-256 的小写十六进制表示（纯 Rust，无外部依赖）。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for byte in sha256(bytes) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut state = SHA256_INITIAL;
    let mut padded = Vec::with_capacity(bytes.len() + 72);
    padded.extend_from_slice(bytes);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&((bytes.len() as u64) * 8).to_be_bytes());

    for block in padded.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_ROUND[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut out = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
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

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn canonical_kernel_matches_js_number_and_key_order() {
        assert_eq!(
            canonical_kernel(&json!({"b": 1, "a": [true, null, "x"]})),
            "{\"a\":[true,null,\"x\"],\"b\":1}"
        );
        // 整数值浮点按 JS `String(Number)` 去尾零。
        assert_eq!(canonical_kernel(&json!(1.0)), "1");
        assert_eq!(canonical_kernel(&json!(0.0)), "0");
        assert_eq!(canonical_kernel(&json!(1.5)), "1.5");
    }

    #[test]
    fn kernel_hash_matches_js_kernel_h_vector() {
        // 对拍 loop-policy `hash.ts` 的 `H`：canonical 键升序、整数值浮点去尾零。
        let value = json!({"body": {"a": 1, "b": [true, null, "x"], "c": 1.0}});
        assert_eq!(
            kernel_hash(&value),
            "c306393cf54660da8dce5108b80d4fdc45effd9bb4baadaee55aac189b741ef1"
        );
    }

    #[test]
    fn kernel_hash_is_64_hex_and_key_order_stable() {
        let left = json!({"body": {"b": 2, "a": 1}});
        let right = json!({"body": {"a": 1, "b": 2}});
        let hash = kernel_hash(&left);
        assert_eq!(hash, kernel_hash(&right));
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }
}
