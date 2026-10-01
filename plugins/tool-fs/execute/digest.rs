// 工具结果摘要（digest）：随成功结果自带，供上下文老化直接渲染，无需装配器认识工具语义。
// 只放确定、有界的展示字段（路径 / 行窗 / 内容哈希 / 规模 / 模式与命中数）；不含时间、不含正文全文。
// 自实现 SHA-256 以免引入编译期加密依赖，口径为小写十六进制。

use serde_json::{json, Value};

// ── SHA-256（纯 Rust，无外部依赖） ──────────────────────────────────────────

const INITIAL: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const ROUND: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// 计算 SHA-256 摘要。
fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut state = INITIAL;
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
                .wrapping_add(ROUND[index])
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

/// SHA-256 的小写十六进制表示。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for byte in sha256(bytes) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 与上下文老化一致的字节规模文本：`<1024B` 原样；否则 KB（≥100 取整，其余一位小数）。
fn format_bytes(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes}B");
    }
    let kb = bytes as f64 / 1024.0;
    if kb >= 100.0 {
        format!("{}KB", kb.round() as i64)
    } else {
        let rounded = (kb * 10.0).round() / 10.0;
        format!("{rounded}KB")
    }
}

/// read 摘要：路径、行窗（`1-240`）、返回窗口内容的 sha256、规模摘要。
pub fn read_digest(
    path: &str,
    start_line: u64,
    end_line: Option<u64>,
    lines_returned: u64,
    text: &str,
) -> Value {
    let lines = match end_line {
        Some(end) => format!("{start_line}-{end}"),
        None => format!("{start_line}"),
    };
    json!({
        "path": path,
        "lines": lines,
        "sha": sha256_hex(text.as_bytes()),
        "summary": format!("{lines_returned} 行 / {}", format_bytes(text.len())),
    })
}

/// 编码读取摘要：路径、编码、原始字节数、编码后文本的 sha256 与规模。
pub fn encoded_read_digest(path: &str, encoding: &str, bytes: u64, text: &str) -> Value {
    json!({
        "path": path,
        "encoding": encoding,
        "bytes": bytes,
        "sha": sha256_hex(text.as_bytes()),
        "summary": format!("{encoding} · {}", format_bytes(bytes as usize)),
    })
}

/// glob / grep 摘要：模式、命中数、涉及文件数（glob 下同 paths 数）。
pub fn search_digest(pattern: &str, hits: usize, files: usize) -> Value {
    json!({ "pattern": pattern, "hits": hits, "files": files })
}

/// read 批量摘要：模式、返回文件数、匹配文件总数（未返回时两者不等，提示非全量）。
pub fn read_many_digest(pattern: &str, returned: usize, matched: usize) -> Value {
    json!({ "pattern": pattern, "files": returned, "matched": matched })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vectors() {
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
    fn read_digest_shape() {
        let digest = read_digest("src/a.ts", 1, Some(240), 240, "hello");
        assert_eq!(digest["path"], "src/a.ts");
        assert_eq!(digest["lines"], "1-240");
        assert_eq!(digest["sha"], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert_eq!(digest["summary"], "240 行 / 5B");
    }

    #[test]
    fn read_digest_empty_window_keeps_start_only() {
        let digest = read_digest("a.txt", 5, None, 0, "");
        assert_eq!(digest["lines"], "5");
        assert_eq!(digest["summary"], "0 行 / 0B");
    }

    #[test]
    fn format_bytes_matches_aging_scale() {
        assert_eq!(format_bytes(0), "0B");
        assert_eq!(format_bytes(1023), "1023B");
        assert_eq!(format_bytes(8397), "8.2KB");
        assert_eq!(format_bytes(1024 * 100), "100KB");
    }

    #[test]
    fn search_digest_shape() {
        let digest = search_digest("fn", 37, 12);
        assert_eq!(digest, json!({ "pattern": "fn", "hits": 37, "files": 12 }));
    }

    #[test]
    fn read_many_digest_shape() {
        let digest = read_many_digest("*.py", 5, 9);
        assert_eq!(digest, json!({ "pattern": "*.py", "files": 5, "matched": 9 }));
    }
}
