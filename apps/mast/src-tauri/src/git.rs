use std::sync::atomic::{AtomicUsize, Ordering};

use mast_core::git::{GitDiff, GitDiffRequest, GitStatus};

static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
const MAX_IN_FLIGHT: usize = 4;

struct GitSlot;

impl GitSlot {
    fn acquire() -> Result<Self, String> {
        IN_FLIGHT
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_IN_FLIGHT).then_some(n + 1)
            })
            .map(|_| Self)
            .map_err(|_| "Git is busy; refresh to retry when other queries finish".into())
    }
}

impl Drop for GitSlot {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

fn distro(distro: Option<String>) -> Option<String> {
    distro
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("MAST_DISTRO").ok().filter(|s| !s.is_empty()))
}

#[tauri::command]
pub async fn git_status(distro: Option<String>, path: String) -> Result<GitStatus, String> {
    // pool 진입 전에 제한해야 빠른 탭 전환이 dispatch 와 공유하는 blocking pool 을
    // 대기 작업으로 채우지 않는다. WSL 기본 배포판은 relay 가 직접 선택한다.
    let slot = GitSlot::acquire()?;
    let distro = self::distro(distro);
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        mast_core::git::status(distro.as_deref(), &path)
    })
    .await
    .map_err(|err| format!("git_status task join failed: {err}"))?
}

#[tauri::command]
pub async fn git_diff(distro: Option<String>, request: GitDiffRequest) -> Result<GitDiff, String> {
    let slot = GitSlot::acquire()?;
    let distro = self::distro(distro);
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        mast_core::git::diff(distro.as_deref(), &request)
    })
    .await
    .map_err(|err| format!("git_diff task join failed: {err}"))?
}
