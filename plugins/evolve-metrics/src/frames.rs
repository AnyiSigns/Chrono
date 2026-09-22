// 服务协议帧编解码与 stdio 读写（docs/protocol.md §一 / §二）。
// 4 字节大端长度 + UTF-8 JSON；stdout 只许协议帧，日志一律走 stderr。

use std::io::{self, Read, Write};

use serde_json::Value;

/// 单帧上限：与宿主 / 客户端解码器一致（16 MiB）。
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 把一条消息编码为一帧（长度前缀 + JSON 字节）。
pub fn encode_frame(message: &Value) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(message)?;
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// 写一帧到协议出口（stdout），立即 flush。
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

/// 日志只走 stderr，绝不污染 stdout 的协议帧。
pub fn log(line: &str) {
    let mut stderr = io::stderr();
    let _ = writeln!(stderr, "[evolve-metrics] {line}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip() {
        let message = json!({"v":"1","id":"1","kind":"hello","impl":"evolve-metrics"});
        let frame = encode_frame(&message).unwrap();
        let mut cursor = io::Cursor::new(frame);
        let decoded = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(decoded, message);
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
        let err = read_frame(&mut cursor).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
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
        let first = encode_frame(&json!({"kind":"probe","id":"a"})).unwrap();
        let second = encode_frame(&json!({"kind":"probe","id":"b"})).unwrap();
        let mut bytes = first;
        bytes.extend_from_slice(&second);
        let mut cursor = io::Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap()["id"], "a");
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap()["id"], "b");
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }
}
