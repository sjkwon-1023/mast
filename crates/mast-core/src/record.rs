//! 끝난 터미널 탭의 **기록 파일** 저장소 (ADR-0018).
//!
//! 셸이 끝나면 세션·replay·sink 를 전부 놓고, 마지막 화면의 재료
//! ([`PtySession::take_record`](crate::session::PtySession::take_record) 가 떠낸
//! 모드 preamble + replay 스냅샷)만 `<app_data_dir>/records/tab-<id>.bin` 으로
//! 남긴다. 파일 내용은 **헤더 없는 raw 바이트** — 읽는 쪽이 그대로 터미널에
//! 흘려보내면 끝난 화면이 다시 선다.
//!
//! 경로를 모델에 저장하지 않고 탭 id 로 유도하는 이유는 앱 데이터 경로가 움직이기
//! 때문이다(rename 마이그레이션 선례) — 절대경로를 영속화하면 그때 전부 깨진다.
//!
//! 기록은 터미널 출력이라 **평문 사용자 데이터**다. 수명 규칙(exit 시 덮어쓰기,
//! respawn 성공 시 삭제, 탭 닫기 시 삭제, 부팅 시 [`RecordStore::sweep`])은
//! ADR-0018 이 정의하고 글루가 집행한다.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use crate::model::TabId;

/// 기록 파일 하나의 크기 상한 — 이보다 큰 파일은 읽지 않고 에러다.
/// 정상 기록은 replay cap(1 MiB) + preamble 이므로 이 값을 넘을 수 없다. 넘겼다면
/// 우리가 쓴 파일이 아니거나 손상된 것이고, 그걸 통째로 메모리에 올려 터미널에
/// 흘려보내는 것이 손해다.
const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;

/// [`RecordStore::sweep`] 한 번의 결과. 실패 수가 따로 있는 이유는 sweep 의
/// rustdoc 에 있다 — 한 항목의 실패가 나머지 청소를 취소하지 않는다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub removed: usize,
    pub failed: usize,
}

/// 기록 파일 디렉터리. 상태를 들지 않으므로 스레드 간 공유가 자유롭다.
pub struct RecordStore {
    dir: PathBuf,
}

impl RecordStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn path(&self, tab: TabId) -> PathBuf {
        self.dir.join(file_name(tab))
    }

    /// 기록을 tmp 에 쓰고 rename 한다 — 중간에 죽어도 반쯤 쓰인 파일이 기록 행세를
    /// 하지 못한다.
    ///
    /// `state.json` 과 달리 **fsync 하지 않는다.** 기록은 버려도 되는 화면 한 장이고,
    /// 원자성은 rename 이 이미 준다. 대신 fsync 는 exit 순서의 ①(replay 를 비운 직후)
    /// 과 ③(모델 갱신) **사이**에 들어앉아, 그 창에 걸린 attach 가 빈 replay 를 받는
    /// 시간을 디스크 지연만큼 늘린다 (ADR-0018 D2·수용 한계). 대가는 이것뿐이다:
    /// rename 직후 OS 가 죽으면 잘린 파일이 남을 수 있고, 그것은 읽는 쪽에 "기록된
    /// 화면이 없다"로 보인다 — 잃는 것이 끝난 셸의 마지막 화면 하나다.
    pub fn write(&self, tab: TabId, bytes: &[u8]) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let final_path = self.path(tab);
        let tmp = self.dir.join(tmp_file_name(tab));
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        drop(file);
        fs::rename(&tmp, &final_path)
    }

    /// 기록 바이트. 파일이 없으면 `Ok(None)` — 기록 없는 탭은 정상이다(뷰가 안내
    /// 한 줄을 그린다). [`MAX_RECORD_BYTES`] 초과는 Err.
    pub fn read(&self, tab: TabId) -> io::Result<Option<Vec<u8>>> {
        let path = self.path(tab);
        let meta = match fs::metadata(&path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        if meta.len() > MAX_RECORD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "record {} is {} bytes, over the {MAX_RECORD_BYTES} cap",
                    path.display(),
                    meta.len()
                ),
            ));
        }
        fs::read(&path).map(Some)
    }

    /// 기록을 지운다. 없으면 `Ok(())` — 호출자 셋(respawn 성공·탭 닫기·빈 기록)
    /// 모두 "없어야 한다"가 의도라 부재는 성공이다.
    pub fn remove(&self, tab: TabId) -> io::Result<()> {
        match fs::remove_file(self.path(tab)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// `keep` 밖의 기록과 남은 tmp 를 지운다 — 앱이 강제 종료돼 삭제 경로를 못 탄
    /// 고아 파일의 유일한 청소부라, 부팅 때 한 번 돈다.
    ///
    /// 파일명이 `tab-<u64>.bin` 으로 파싱되는 항목만 판정 대상이다. 파싱되지 않는
    /// 항목은 우리가 쓴 것이 아니므로 건드리지 않는다 — 사용자가 같은 디렉터리에
    /// 무언가 두었을 때 앱이 그것을 지우는 일은 없어야 한다. 남은 tmp 도 같은 규율을
    /// 따른다: `.tmp` 를 떼고도 `tab-<u64>.bin` 이어야 지운다(우리가 쓰는 tmp 이름이
    /// 정확히 그것이다). 그쪽만 이름을 안 보면 `foo.tmp` 를 남의 것인 줄 모르고 지운다.
    /// 우리 tmp 는 rename 전에 죽은 흔적이라 keep 집합과 무관하게 지운다.
    ///
    /// **항목 하나의 실패로 멈추지 않는다.** Windows 에서는 다른 프로세스가 열고
    /// 있는 파일 하나(두 번째 인스턴스, 갓 쓴 파일을 훑는 백신)가 sharing violation
    /// 으로 실패하는데, 거기서 중단하면 그 부팅의 나머지 고아가 전부 살아남는다 —
    /// 한 번뿐인 청소부에게는 그게 더 나쁘다. 실패는 세어서 [`SweepReport`] 로
    /// 돌려주고 글루가 로그로 드러낸다. Err 는 디렉터리 자체를 못 읽은 경우뿐이다.
    ///
    /// 디렉터리가 아직 없으면 지울 것도 없으므로 빈 보고다(첫 부팅).
    pub fn sweep(&self, keep: &HashSet<TabId>) -> io::Result<SweepReport> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Ok(SweepReport::default())
            }
            Err(err) => return Err(err),
        };
        let mut report = SweepReport::default();
        for entry in entries {
            // 항목 하나를 못 읽는 것도 그 항목의 실패일 뿐이다.
            let Ok(entry) = entry else {
                report.failed += 1;
                continue;
            };
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let doomed = match name.strip_suffix(".tmp") {
                // 우리 tmp 만 지운다 — 참조하는 탭이 있든 없든 rename 전에 죽은 흔적이다.
                Some(stem) => parse_file_name(stem).is_some(),
                None => match parse_file_name(name) {
                    Some(tab) => !keep.contains(&tab),
                    None => false,
                },
            };
            if !doomed {
                continue;
            }
            match remove_if_present(&path) {
                Ok(true) => report.removed += 1,
                Ok(false) => {}
                Err(_) => report.failed += 1,
            }
        }
        Ok(report)
    }
}

fn file_name(tab: TabId) -> String {
    format!("tab-{}.bin", tab.0)
}

/// [`RecordStore::write`] 의 tmp 이름. `sweep` 이 남은 tmp 를 알아보는 근거도 이것이라
/// 한 곳에서 만든다 — 이름이 갈리면 sweep 이 자기 쓰레기를 못 알아본다.
fn tmp_file_name(tab: TabId) -> String {
    format!("{}.tmp", file_name(tab))
}

/// `tab-<u64>.bin` 만 탭 id 로 읽는다. `u64::from_str` 이 받아 주는 `+7` 같은 형태는
/// 우리가 쓴 이름이 아니므로 거른다 ([`Dispatcher::resolve_send_target`] 의 `#id`
/// 파싱과 같은 규율).
///
/// [`Dispatcher::resolve_send_target`]: crate::command::Dispatcher::resolve_send_target
fn parse_file_name(name: &str) -> Option<TabId> {
    let digits = name.strip_prefix("tab-")?.strip_suffix(".bin")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().map(TabId)
}

/// 삭제하고 "실제로 있었는가" 를 돌려준다 — sweep 과 read_dir 사이에 사라진 파일을
/// 실패로 보지 않기 위해서다.
fn remove_if_present(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, RecordStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = RecordStore::new(dir.path().join("records"));
        (dir, store)
    }

    #[test]
    fn write_creates_the_directory_and_read_returns_the_bytes() {
        let (_dir, store) = store();
        store.write(TabId(7), b"\x1b[?2004hlast screen").unwrap();
        assert_eq!(
            store.read(TabId(7)).unwrap().as_deref(),
            Some(&b"\x1b[?2004hlast screen"[..])
        );
        assert_eq!(store.path(TabId(7)).file_name().unwrap(), "tab-7.bin");
    }

    #[test]
    fn write_leaves_no_tmp_behind_and_overwrites_the_previous_record() {
        let (_dir, store) = store();
        store.write(TabId(1), b"first").unwrap();
        store.write(TabId(1), b"second").unwrap();
        assert_eq!(
            store.read(TabId(1)).unwrap().as_deref(),
            Some(&b"second"[..])
        );
        let leftovers: Vec<String> = fs::read_dir(store.path(TabId(1)).parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["tab-1.bin".to_string()]);
    }

    #[test]
    fn read_of_a_missing_record_is_none() {
        let (_dir, store) = store();
        assert!(store.read(TabId(9)).unwrap().is_none());
    }

    #[test]
    fn read_refuses_a_file_over_the_cap() {
        let (_dir, store) = store();
        fs::create_dir_all(store.path(TabId(3)).parent().unwrap()).unwrap();
        fs::write(
            store.path(TabId(3)),
            vec![0u8; MAX_RECORD_BYTES as usize + 1],
        )
        .unwrap();
        let err = store.read(TabId(3)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn remove_is_ok_whether_the_record_exists_or_not() {
        let (_dir, store) = store();
        store.write(TabId(4), b"x").unwrap();
        store.remove(TabId(4)).unwrap();
        assert!(store.read(TabId(4)).unwrap().is_none());
        store.remove(TabId(4)).unwrap();
    }

    #[test]
    fn sweep_removes_unkept_records_and_leftover_tmp_files_only() {
        let (_dir, store) = store();
        store.write(TabId(1), b"keep").unwrap();
        store.write(TabId(2), b"drop").unwrap();
        let dir = store.path(TabId(1)).parent().unwrap().to_path_buf();
        // rename 전에 죽은 흔적과, 우리가 쓰지 않은 이름들.
        fs::write(dir.join("tab-7.bin.tmp"), b"half").unwrap();
        fs::write(dir.join("tab-+3.bin"), b"not ours").unwrap();
        fs::write(dir.join("foo.tmp"), b"not ours either").unwrap();
        fs::write(dir.join("notes.txt"), b"user file").unwrap();

        let keep: HashSet<TabId> = [TabId(1)].into_iter().collect();
        assert_eq!(
            store.sweep(&keep).unwrap(),
            SweepReport {
                removed: 2,
                failed: 0
            }
        );

        assert!(store.read(TabId(1)).unwrap().is_some());
        assert!(store.read(TabId(2)).unwrap().is_none());
        assert!(!dir.join("tab-7.bin.tmp").exists());
        assert!(
            dir.join("tab-+3.bin").exists(),
            "파싱 안 되는 .bin 은 우리 것이 아니다"
        );
        assert!(
            dir.join("foo.tmp").exists(),
            "우리 tmp 이름이 아닌 .tmp 도 우리 것이 아니다"
        );
        assert!(dir.join("notes.txt").exists());
    }

    /// 우리 tmp 는 그 탭이 keep 에 있어도 지운다 — rename 전에 죽은 흔적이라
    /// 아무도 참조하지 않는다.
    #[test]
    fn sweep_removes_our_tmp_even_for_a_kept_tab() {
        let (_dir, store) = store();
        store.write(TabId(1), b"keep").unwrap();
        let dir = store.path(TabId(1)).parent().unwrap().to_path_buf();
        fs::write(dir.join("tab-1.bin.tmp"), b"half").unwrap();

        let keep: HashSet<TabId> = [TabId(1)].into_iter().collect();
        assert_eq!(
            store.sweep(&keep).unwrap(),
            SweepReport {
                removed: 1,
                failed: 0
            }
        );
        assert!(store.read(TabId(1)).unwrap().is_some());
        assert!(!dir.join("tab-1.bin.tmp").exists());
    }

    #[test]
    fn sweep_on_a_missing_directory_removes_nothing() {
        let (_dir, store) = store();
        assert_eq!(store.sweep(&HashSet::new()).unwrap(), SweepReport::default());
    }

    /// 지울 수 없는 항목 하나가 나머지 청소를 취소하지 않는다 — 한 번뿐인 청소부가
    /// 첫 실패에서 멈추면 그 부팅의 고아가 전부 살아남는다. 실기에서 이 자리를
    /// 만드는 것은 열려 있는 파일의 sharing violation 인데, 테스트에서는 같은
    /// `remove_file` 실패를 결정적으로 만드는 쪽(이름만 기록인 디렉터리)을 쓴다.
    #[test]
    fn sweep_keeps_going_past_an_entry_it_cannot_delete() {
        let (_dir, store) = store();
        store.write(TabId(2), b"drop").unwrap();
        let dir = store.path(TabId(2)).parent().unwrap().to_path_buf();
        fs::create_dir(dir.join("tab-5.bin")).unwrap();

        let report = store.sweep(&HashSet::new()).unwrap();
        assert_eq!(
            report,
            SweepReport {
                removed: 1,
                failed: 1
            }
        );
        assert!(store.read(TabId(2)).unwrap().is_none());
        assert!(dir.join("tab-5.bin").exists());
    }
}
