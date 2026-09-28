#![cfg(target_os = "linux")]
// cgroup v2 资源上限：为每次执行建 `chrono-<id>/`，写 `memory.max` / `pids.max`，子进程在
// `pre_exec` 里把自身迁入（写 `cgroup.procs` 的 `0`），进程退出后清理目录。
//
// `cpu.max` 语义是**带宽**（每周期配额），与 `cpu_ms` 的「总 CPU 时间」不是一回事；故 `cpu.ms`
// 仍由 `RLIMIT_CPU` 强制，这里只显式写 `max`（不受速率限制）以免误导。内存 / 进程数是真强制：
// 内存超限由内核 OOM 杀（可由 `memory.events` 判定 `oom`），进程数超限表现为 fork 失败。
//
// 不可用（无 cgroup v2 / 只读）时返回 `None`，调用方回退 `rlimit` 并如实标注。

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// cgroup v2 统一层级是否可用（`cgroup.controllers` 存在即视为已挂载）。
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| Path::new(CGROUP_ROOT).join("cgroup.controllers").exists())
}

/// 一次执行对应的 cgroup；`Drop` 不做清理（清理需在进程结束后，由调用方显式 `cleanup`）。
pub struct Cgroup {
    path: PathBuf,
}

impl Cgroup {
    /// 建目录并写入上限；任一步失败即回滚并返回 `None`（调用方回退 rlimit）。
    pub fn create(id: &str, mem_bytes: u64, pids_max: u32) -> Option<Cgroup> {
        if !available() {
            return None;
        }
        let path = Path::new(CGROUP_ROOT).join(format!("chrono-{id}"));
        // 同名残留（上次异常退出）：先清掉，避免写入落在旧限制上。
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).ok()?;
        if mem_bytes > 0 && fs::write(path.join("memory.max"), mem_bytes.to_string()).is_err() {
            let _ = fs::remove_dir(&path);
            return None;
        }
        if pids_max > 0 && fs::write(path.join("pids.max"), pids_max.to_string()).is_err() {
            let _ = fs::remove_dir(&path);
            return None;
        }
        // 显式声明不受 cgroup CPU 速率限制（总 CPU 由 RLIMIT_CPU 管）。
        let _ = fs::write(path.join("cpu.max"), "max 100000");
        Some(Cgroup { path })
    }

    /// 打开 `cgroup.procs` 供子进程在 `pre_exec` 里写 `0`（把自身迁入本 cgroup）。
    pub fn procs_file(&self) -> io::Result<File> {
        OpenOptions::new().write(true).open(self.path.join("cgroup.procs"))
    }

    /// 是否发生过 OOM 击杀（读 `memory.events` 的 `oom_kill`）。
    pub fn oom_killed(&self) -> bool {
        let Ok(text) = fs::read_to_string(self.path.join("memory.events")) else {
            return false;
        };
        text.lines().any(|line| {
            line.strip_prefix("oom_kill ")
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(|count| count > 0)
                .unwrap_or(false)
        })
    }

    /// 回收：先 `cgroup.kill` 兜底杀残留，再删目录（cgroupfs 删除可能短暂 EBUSY，重试）。
    pub fn cleanup(&self) {
        let _ = fs::write(self.path.join("cgroup.kill"), "1");
        for _ in 0..20 {
            if fs::remove_dir(&self.path).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = fs::remove_dir(&self.path);
    }
}

/// 清理目录上限（防御性；正常路径由调用方 `cleanup`）。返回目录路径供测试断言。
pub fn dir_for(id: &str) -> PathBuf {
    Path::new(CGROUP_ROOT).join(format!("chrono-{id}"))
}

/// 供测试：确认目录不存在。
#[cfg(test)]
pub fn dir_exists(id: &str) -> bool {
    dir_for(id).exists()
}

/// 供测试：等待目录消失（清理可能异步于进程退出）。
#[cfg(test)]
pub fn wait_gone(id: &str, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if !dir_exists(id) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    !dir_exists(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_writes_limits_and_cleans_up() {
        if !available() {
            return;
        }
        let id = format!("test-{}", std::process::id());
        let group = Cgroup::create(&id, 64 * 1024 * 1024, 7).expect("cgroup create");
        assert!(dir_exists(&id));
        let mem = fs::read_to_string(dir_for(&id).join("memory.max")).unwrap();
        assert_eq!(mem.trim(), (64 * 1024 * 1024u64).to_string());
        let pids = fs::read_to_string(dir_for(&id).join("pids.max")).unwrap();
        assert_eq!(pids.trim(), "7");
        group.cleanup();
        assert!(wait_gone(&id, Duration::from_secs(2)));
    }
}
