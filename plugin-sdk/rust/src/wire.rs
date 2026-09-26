// 服务协议帧编解码与规范序列化（docs/protocol.md §一 / §二）。
// 4 字节大端长度 + 规范 JSON 字节；stdout 只许协议帧，日志一律走 stderr。
// 零内核零宿主依赖：规范序列化自带，与宿主线格式（TS `canonical.ts`）逐字节一致——
// 键按 UTF-16 code-unit 升序、-0 归一为 0、数字用 JS 最短往返表示。

use std::cmp::Ordering;
use std::io::{self, Read, Write};

use serde_json::Value;

/// 服务协议版本；与 `plugin.json.protocol` 同源口径。
pub const SERVICE_PROTOCOL_VERSION: &str = "1";

/// 单帧上限：与宿主 / 客户端解码器一致（16 MiB）。
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 递归序列化深度上限：与内核口径同源。
pub const MAX_JSON_DEPTH: usize = 64;

/// 把一条消息编码为一帧（长度前缀 + 规范 JSON 字节）。
pub fn encode_frame(message: &Value) -> io::Result<Vec<u8>> {
    let body = canonical_json(message)?.into_bytes();
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// 写一帧到协议出口，立即 flush。
pub fn write_frame<W: Write>(writer: &mut W, message: &Value) -> io::Result<()> {
    let frame = encode_frame(message)?;
    writer.write_all(&frame)?;
    writer.flush()
}

/// 读一帧；**干净 EOF 返回 `Ok(None)`**（服务据此自退出），坏帧 / 超限返回 `Err`。
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    if !read_header(reader, &mut header)? {
        return Ok(None);
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame_too_large"));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let message: Value = serde_json::from_slice(&body)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    Ok(Some(message))
}

/// 读 4 字节头：开头即 EOF 返回 `false`；读到一半断开返回错误。
fn read_header<R: Read>(reader: &mut R, header: &mut [u8; 4]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < 4 {
        let read = reader.read(&mut header[filled..])?;
        if read == 0 {
            if filled == 0 {
                return Ok(false);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated frame header",
            ));
        }
        filled += read;
    }
    Ok(true)
}

/// 日志只走 stderr，绝不污染 stdout 的协议帧；前缀由调用插件给出。
pub fn log(prefix: &str, line: &str) {
    let _ = writeln!(io::stderr(), "[{prefix}] {line}");
}

/// 规范序列化：键按 UTF-16 code-unit 升序、-0 归一为 0、数字用 JS 最短往返表示。
pub fn canonical_json(value: &Value) -> io::Result<String> {
    let mut out = String::new();
    write_canonical(value, &mut out, 0)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String, depth: usize) -> io::Result<()> {
    if depth > MAX_JSON_DEPTH {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "depth"));
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&format_number(number)),
        Value::String(text) => out.push_str(&quote(text)),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&quote(key));
                out.push(':');
                write_canonical(&map[*key], out, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// 键按 UTF-16 code-unit 升序比较（与 JS `Array.prototype.sort` 的默认序一致）。
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// JSON 字符串转义：与 JS `JSON.stringify` 同口径（非 ASCII 原样输出）。
fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| String::from("\"\""))
}

/// 数字表示：整数变体原样输出；浮点走 JS `String(n)` 的最短往返格式。
fn format_number(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    format_f64(number.as_f64().unwrap_or(0.0))
}

/// f64 的 JS `String(n)` 表示：-0 归一为 0；其余按 ECMAScript Number::toString 规则排版。
fn format_f64(value: f64) -> String {
    if value == 0.0 {
        return String::from("0");
    }
    let negative = value.is_sign_negative();
    let (digits, point) = shortest_digits(value.abs());
    let body = layout(&digits, point);
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

/// 从 Rust 最短往返指数表示取出有效数字与「小数点位置」n：
/// value = 0.digits × 10^n，且 digits 首位非零。
fn shortest_digits(magnitude: f64) -> (String, i32) {
    let text = format!("{magnitude:e}");
    let (mantissa, exponent) = text
        .split_once('e')
        .expect("exponential formatting always contains 'e'");
    let exponent: i32 = exponent.parse().expect("exponent is an integer");
    let digits: String = mantissa.chars().filter(|ch| *ch != '.').collect();
    (digits, exponent + 1)
}

/// ECMAScript Number::toString 排版：定点 / 前导零 / 指数三档。
fn layout(digits: &str, n: i32) -> String {
    let length = digits.len() as i32;
    if length <= n && n <= 21 {
        let mut out = String::from(digits);
        for _ in 0..(n - length) {
            out.push('0');
        }
        out
    } else if 0 < n && n <= 21 {
        let split = n as usize;
        format!("{}.{}", &digits[..split], &digits[split..])
    } else if -6 < n && n <= 0 {
        let mut out = String::from("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(digits);
        out
    } else {
        let exponent = n - 1;
        let mantissa = if digits.len() == 1 {
            digits.to_string()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        let sign = if exponent >= 0 { '+' } else { '-' };
        format!("{mantissa}e{sign}{}", exponent.abs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip() {
        let message = json!({"v":"1","id":"1","kind":"hello","impl":"toy"});
        let frame = encode_frame(&message).unwrap();
        let mut cursor = io::Cursor::new(frame);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), message);
    }

    #[test]
    fn clean_eof_is_none() {
        let mut cursor = io::Cursor::new(Vec::new());
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn truncated_header_is_error() {
        let mut cursor = io::Cursor::new(vec![0u8, 0u8]);
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn oversized_frame_rejected() {
        let mut frame = ((MAX_FRAME_BYTES as u32) + 1).to_be_bytes().to_vec();
        frame.extend_from_slice(&[0u8; 8]);
        let mut cursor = io::Cursor::new(frame);
        assert_eq!(read_frame(&mut cursor).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn bad_json_rejected() {
        let body = b"not json";
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(body);
        let mut cursor = io::Cursor::new(frame);
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn two_frames_back_to_back() {
        let mut bytes = encode_frame(&json!({"kind":"probe","id":"a"})).unwrap();
        bytes.extend_from_slice(&encode_frame(&json!({"kind":"probe","id":"b"})).unwrap());
        let mut cursor = io::Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap()["id"], "a");
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap()["id"], "b");
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn canonical_sorts_keys_and_normalizes() {
        assert_eq!(
            canonical_json(&json!({"b": 1, "a": 2})).unwrap(),
            "{\"a\":2,\"b\":1}"
        );
        assert_eq!(canonical_json(&json!(-0.0)).unwrap(), "0");
        assert_eq!(canonical_json(&json!([1, "a", null, true])).unwrap(), "[1,\"a\",null,true]");
    }

    #[test]
    fn canonical_escapes_strings_like_json() {
        assert_eq!(canonical_json(&json!("a\"b\\c\n")).unwrap(), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(canonical_json(&json!("中文")).unwrap(), "\"中文\"");
    }

    /// 数字排版与 JS `String(n)` 一致（最短往返 + 定点 / 指数分界）。
    #[test]
    fn canonical_number_formatting_matches_js() {
        let cases: &[(f64, &str)] = &[
            (1.0, "1"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (100.0, "100"),
            (123.456, "123.456"),
            (100000000000000000000.0, "100000000000000000000"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (-1.5, "-1.5"),
        ];
        for (value, expected) in cases {
            assert_eq!(canonical_json(&json!(*value)).unwrap(), *expected, "value {value}");
        }
    }

    #[test]
    fn canonical_depth_guard() {
        let mut nested = json!(0);
        for _ in 0..(MAX_JSON_DEPTH + 2) {
            nested = Value::Array(vec![nested]);
        }
        assert!(canonical_json(&nested).is_err());
    }

    /// 帧字节与 TS `wire.ts` / `canonical.ts` 口径一致：键升序、`-0 → 0`、长度前缀 = 规范 JSON 字节数。
    #[test]
    fn frame_bytes_match_ts_canonical() {
        let message =
            json!({"v":"1","id":"x","kind":"call","port":"toy","method":"echo","args":{"b":1,"a":2,"n":-0.0}});
        let body = canonical_json(&message).unwrap();
        assert_eq!(
            body,
            r#"{"args":{"a":2,"b":1,"n":0},"id":"x","kind":"call","method":"echo","port":"toy","v":"1"}"#
        );
        let frame = encode_frame(&message).unwrap();
        let length = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(length, body.len());
        assert_eq!(&frame[4..], body.as_bytes());
    }
}
