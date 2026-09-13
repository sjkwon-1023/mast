use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const MAX_RELEASE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub newer_version: Option<String>,
    pub checked: bool,
}

pub struct UpdateCheck {
    started: AtomicBool,
    info: Mutex<UpdateInfo>,
}

impl UpdateCheck {
    pub fn new(current_version: &str) -> Self {
        Self {
            started: AtomicBool::new(false),
            info: Mutex::new(UpdateInfo {
                current_version: current_version.to_owned(),
                newer_version: None,
                checked: false,
            }),
        }
    }

    pub fn begin(&self) -> bool {
        !self.started.swap(true, Ordering::AcqRel)
    }

    pub fn snapshot(&self) -> UpdateInfo {
        self.info.lock().unwrap().clone()
    }

    pub fn finish(&self, newer_version: Option<String>) -> UpdateInfo {
        let mut info = self.info.lock().unwrap();
        info.newer_version = newer_version;
        info.checked = true;
        info.clone()
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

fn stable_version(text: &str) -> Option<[u64; 3]> {
    let text = text.strip_prefix('v').unwrap_or(text);
    let mut parts = text.split('.');
    let mut result = [0; 3];
    for value in &mut result {
        let part = parts.next()?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        *value = part.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

pub fn newer_release(current: &str, body: &[u8]) -> Result<Option<String>, String> {
    if body.len() > MAX_RELEASE_BYTES {
        return Err("release response exceeds 64 KiB".into());
    }
    let release: Release = serde_json::from_slice(body).map_err(|err| err.to_string())?;
    if release.draft || release.prerelease {
        return Ok(None);
    }
    let installed = stable_version(current).ok_or("invalid installed stable version")?;
    let latest = stable_version(&release.tag_name).ok_or("invalid release stable version")?;
    Ok((latest > installed).then(|| release.tag_name.trim_start_matches('v').to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "tag_name": tag, "draft": false, "prerelease": false,
            "html_url": "https://untrusted.example/ignored"
        }))
        .unwrap()
    }

    #[test]
    fn numeric_versions_and_downgrades() {
        for (installed, tag, expected) in [
            ("0.3.9", "v0.3.31", Some("0.3.31")),
            ("0.3.31", "v0.3.31", None),
            ("0.3.31", "v0.3.9", None),
            ("0.3.31", "0.4.0", Some("0.4.0")),
            ("0.9.99", "v1.0.0", Some("1.0.0")),
        ] {
            assert_eq!(
                newer_release(installed, &release(tag)).unwrap().as_deref(),
                expected
            );
        }
    }

    #[test]
    fn malformed_tags_and_json_never_become_updates() {
        for tag in [
            "v0.4.0-rc.1",
            "v0.4.0+build",
            "vv1.0.0",
            "01.2.3",
            "1.2",
            "1.2.3.4",
            "1.+2.3",
            "1.2.18446744073709551616",
            "1.2.3/path",
            "",
        ] {
            assert!(newer_release("0.3.31", &release(tag)).is_err(), "{tag}");
        }
        for body in [b"not JSON".as_slice(), b"{}", b"[]"] {
            assert!(newer_release("0.3.31", body).is_err());
        }
        assert!(newer_release("0.3.31", &vec![b' '; MAX_RELEASE_BYTES + 1]).is_err());
    }

    #[test]
    fn draft_and_prerelease_are_ignored() {
        for (draft, prerelease) in [(true, false), (false, true)] {
            let body = serde_json::to_vec(
                &serde_json::json!({"tag_name":"v1.0.0", "draft":draft, "prerelease":prerelease}),
            )
            .unwrap();
            assert_eq!(newer_release("0.3.31", &body).unwrap(), None);
        }
    }

    #[test]
    fn failure_is_cached_and_reading_never_restarts_a_check() {
        let cache = UpdateCheck::new("0.3.31");
        assert!(!cache.snapshot().checked);
        assert!(cache.begin());
        assert!(!cache.begin());
        cache.finish(None);
        assert!(cache.snapshot().checked);
        assert_eq!(cache.snapshot().current_version, "0.3.31");
        assert!(!cache.begin());
    }

    #[test]
    fn only_one_concurrent_caller_can_start() {
        let cache = std::sync::Arc::new(UpdateCheck::new("0.3.31"));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                std::thread::spawn(move || cache.begin())
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().then_some(()))
                .count(),
            1
        );
        let info = cache.finish(Some("0.3.32".into()));
        assert_eq!(cache.snapshot(), info);
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({"currentVersion":"0.3.31", "newerVersion":"0.3.32", "checked":true})
        );
    }
}
