# exited tab = terminal record + backend hygiene — 확정 실행계획

> **상태: 확정(2026-09-12), 실행 중.** `/review-plan`(Opus 초안 → Opus 반증 → 메인 취합)을 거쳤다.
> 완료되면 ADR-0018 로 증류하고 이 파일은 삭제한다. 브랜치 `feat/exited-tab-record`, 버전 **0.3.25**
> (`fix/reattach-redraw` 가 0.3.24 를 쓴다).

## 0. 반증에서 채택·기각한 것

반증 판정은 **revise** 였다. 채택(전부 아래 청크에 반영):

- **1a 게이트 컴파일 실패** — `crates/mast-remote/src/handlers.rs:166` 이 `TerminalStatus::Exited { code: None }`
  을 구성한다(뷰어 탭을 "세션 없음"으로 접는 자리). 필드 추가는 이 리터럴을 깨므로 1a 대상에 넣는다(원격 API
  변경이 아니라 리터럴 보정). 같은 파일 `live_session` rustdoc(113-115행)의 "Exited 탭도 `pty_session` 을 들고
  있다" 절반은 거짓이 되므로 같이 고친다(NotStarted 절반은 유효).
- **`ReplayBuffer::clear()` 는 `evicted` 를 건드리지 않는다** — `replay.rs:30-33` 의 명시 불변식("리셋되지
  않는다"). `take_record` 뒤에도 리더가 마지막 chunk 를 push 할 수 있어 빈 버퍼가 곧 스트림 처음이 아니다.
- **`take_record` 는 리더의 마지막 push 와 경합한다** — waiter 가 `alive=false` 를 세운 뒤 `on_exit` 을 부르는
  동안 리더는 별도 스레드에서 `replay.push` 중일 수 있다. 오늘의 Exited 표시(attach 시점에 replay 를 읽음)보다
  tail 한 chunk 만큼 짧을 수 있다. D1 문면을 "오늘과 같거나 tail 한 chunk 만큼 짧다"로 정정하고 ADR accepted
  limits 에 `session.rs:687-689` 의 기존 tail 유실과 **구분해** 적는다.
- **폰이 보는 것은 blank** — replay 를 비우면 `retained_start == end_offset` 이 되어 `since < end_offset` 요청이
  `reset: true` + preamble 만 받는다(1~3단계 사이 창). 종착 상태는 오늘과 같은 409. 리스크 문면 정정.
- **`running_terminal_tabs` rustdoc(`command.rs:681-683`)** "재시작이 곧 되살리기다"는 D3 이후 거짓 — 1a 에서 고친다.
- **CLAUDE.md 의 ADR-0010 항목**("restore normalizes `Exited` → `Running` so a restart revives every tab") 도
  거짓이 된다 — 그 반쪽만 고친다(NotStarted 문장은 유효). 청크 6 대상에 추가.
- **픽스처 경로는 레포 루트 `fixtures/stage10-snapshot.json`**, 값은 `code: null` 유지 + `endedAtMs` 추가
  (`types.test.ts:275-277` 이 nullable 계약을 잠근다).
- **TS 리터럴 일괄 수정 대상**은 `view-reconcile.test.ts`·`tab-strip-model.test.ts`·`sidebar-model.test.ts`·
  `pane-view.test.ts`·`types.test.ts` (`sidebar.test.ts`·`keys.test.ts` 에는 없다).
- **`RecordView` 의 바이트 경로에 자동 커버리지를 둔다** — "바이트 → 터미널" 배선을 `{ write(data) }` 인터페이스만
  받는 순수 함수로 분리해 스텁과 `@xterm/headless`(`remote/tab-view.test.ts` 선례) 양쪽으로 잠근다. v0.3.18 이
  blind 로 나간 원인이 정확히 이 종류의 미검증이었다.
- **청크 2 리뷰 체크리스트 보강** — (1) sweep 은 **첫 스폰 이전**(dogfood dispatch·부팅 웨이브보다 앞) 에 끝난다,
  (2) `records.write` 실패는 exit 시퀀스를 중단시키지 않는다, (3) `release_tabs` 의 기록 삭제가 Close* 세 경로
  전부에 닿고 `SessionExited` 에는 닿지 않는다.
- **sweep 의 keep 집합은 로드된 상태의 전 터미널 탭 id** 로 넓힌다(Exited 만이 아니라). sweep 의 목적은 사라진
  탭의 고아 정리이므로 넓혀도 정확하고, Running 탭의 낡은 기록은 respawn 성공 시 삭제된다.
- **respawn 성공 시 기록 삭제는 호출 지점마다** — `commands.rs::respawn_tab` 과 `boot.rs` 웨이브 둘 다 같은 글루
  헬퍼를 거친다.
- **Saver 슬롯은 flush↔schedule 순서 보장을 잃지 않는다** — worker 는 lock 안에서 `pending` 이 `None` 일 때만
  `flush_done` 을 올린다(있으면 꺼내 lock 밖에서 쓰고 다시 확인). `main.rs:321-322` 의 `router.flush_now()` →
  `saver.flush()` 종료 계약이 이에 의존한다.
- **1a 단독 상태는 런타임 누수**(exit 이 `pty_session` 을 비우는데 레지스트리 해제는 2 가 함) — 같은 PR 안에서만
  허용, 1a 단독 머지 금지. 청크 커밋 메시지에 명시.
- **`apply_osc` 의 `Exited` 가드(`command.rs:600-607`)는 도달 불가**가 된다 — 제거하고, 테스트는 "세션 없는 exited
  탭에 늦게 온 델타는 locate 실패로 무해"를 잠그게 다시 쓴다.
- `RecordView.update()` 는 **항상 no-op** — 마운트 중 기록은 바뀌지 않는다(respawn 성공은 unmount, 실패는 기록 유지).
  배너의 code·시각은 pane-view 가 스냅샷에서 그린다.
- in-flight `attach_terminal` 이 exit 과 겹치면 미지 세션 에러로 `showAttachError` 1프레임 — accepted limit.
- (c) `respawn_tab` 의 Some/None 양쪽 테스트와 `SessionStats.replay_bytes` 테스트를 1a/1b 완료 조건에 명시.

기각(근거):

- **일괄 되살리기(워크스페이스 단위 Restart)를 이번 범위에 넣자** — 넣지 않는다. D3 의 결과로 절전 뒤 탭마다
  Restart 가 필요해지는 것은 사실이며 ADR accepted limits 와 CLAUDE.md 백로그에 **후속 항목**으로 적는다. 이번
  PR 은 계약 반전과 위생에 집중한다.
- **리스크 7·8(`SessionStats` 리터럴, `mast ls` 누출)** — 과대평가: `TabInfo` 는 `status: &'static str` 이라 구조적으로
  샐 수 없고, `SessionStats` 구성 지점은 `session.rs:532` 하나다. 확인 완료로 내린다.

브리프 3.8 의 "pane 의 ResizeObserver 확장" 은 초안·반증 모두 레포 관례(뷰어는 각자 observer)와 어긋난다고 봤다 —
**`RecordView` 자체 observer** 로 확정. `read_tab_record(tab: u64)` 도 커맨드 관례대로 확정.

## 1. 고정 결정 (브리프 4절, 정정 포함)

- **D1 기록 = raw 바이트**(`reattach()` 재료: DEC 모드 preamble + replay 스냅샷). 충실도는 오늘의 Exited 표시와
  같거나 **tail 한 chunk 만큼 짧다**. 상한 replay cap 1 MiB + preamble.
- **D2 exit 처리(waiter 스레드)**: ① `take_record` → ② 기록 파일 쓰기(Dispatcher lock 밖) → ③ lock 안에서
  `SessionExited { code, ended_at_ms }` 적용 + publish → 명시적 unlock → ④ sink·세션 레지스트리 제거 → ⑤ audit.
- **D3 기록은 재시작을 넘어 남는다**: `sanitize` 는 `Exited` 유지, `NotStarted → Running` 만. 부팅 재스폰은
  Running 만(코드 불변, rustdoc 정정).
- **D4 파일명은 탭 id 유도**(`records/tab-<id>.bin`), 모델에 경로 없음.
- **D5 orphan = 레지스트리에 있고 어떤 탭도 참조하지 않음**, 반대 방향(탭이 참조하는데 레지스트리에 없음)은 탭을
  Exited 로 수리만. 주기 타이머 없음. **잠금 순서는 Dispatcher lock 을 잡은 채 레지스트리 id 를 뜬다**(1b 반증에서
  정정 — 아래 청크 4). 세션 생성(레지스트리 insert)과 모델 기록은 같은 dispatch 임계구역 안에서 끝나므로 lock
  아래 스냅샷에서의 부재는 진짜 부재이고, 반대로 lock 보다 먼저 뜬 레지스트리 스냅샷은 갓 만든 멀쩡한 탭을
  dangling 으로 오판해 살아 있는 셸을 Exited 로 끊는다(파괴적). 잠금 방향은 dispatch 와 같아(Dispatcher →
  레지스트리) 순환이 없다.
- **D6 원격 불변**(exited 탭 409). **D7 Saver 슬롯**(대기 clone ≤ 1, flush 순서 보장 유지).

## 2. 청크

순서 1a → 1b → 2 → 3 → 4 → 5 → 6. 청크마다 트리 green(레포 `## Gates` 전부). 서브 에이전트는 커밋하지 않고
메인이 diff·게이트 확인 뒤 커밋한다.

### 1a — 코어 계약 뒤집기 [high · 파급 넓음, 1a 단독 머지 금지]

- `crates/mast-core/src/model.rs`: `TerminalStatus` serde 에 `rename_all_fields = "camelCase"` 추가,
  `Exited { code: Option<u32>, #[serde(default)] ended_at_ms: Option<u64> }`. `TabKind::Terminal.pty_session` rustdoc
  을 "살아 있는 세션에만 Some — exited 탭의 마지막 화면은 기록 파일(ADR-0018)" 로. JSON 키 `endedAtMs` 를 직접
  assert 하는 테스트.
- `crates/mast-core/src/command.rs`: `SessionEvent::SessionExited { session, code, ended_at_ms: u64 }`;
  `apply_event` 가 `*pty_session = None` + `Exited { code, ended_at_ms: Some(..) }` (`changed` 는 세션 제거도 포함),
  `started_sessions.remove`, `reset_agent_source` 유지; `respawn_tab` 실패 강등 `Exited { code: None, ended_at_ms:
  None }`, (c) rustdoc·Err 분기 주석의 "replay 표시용 id" 근거 삭제; `running_terminal_tabs` rustdoc 의 "재시작이
  곧 되살리기" 문단을 D3 로 교체; `apply_osc` 의 `Exited` 가드 제거(locate 실패가 대신한다 — 주석 갱신).
- `crates/mast-core/src/persist.rs`: `sanitize` 는 `pty_session = None` 유지, `NotStarted → Running` 만. 모듈 rustdoc
  "복원 시 sanitize" 절의 Exited 문단을 D3 근거로 교체(Restart 배너가 되살릴 길이고, 절전 뒤 앱은 살아 있다).
- `crates/mast-remote/src/handlers.rs:166`: 리터럴에 `ended_at_ms: None` 추가; `live_session` rustdoc 의 Exited 절반 정정.
  `crates/mast-remote/tests/server.rs:468` 리터럴 보정.
- `fixtures/stage10-snapshot.json`: exited 탭 `"ptySession": null`, `"status": {"type":"exited","code":null,
  "endedAtMs":<고정값>}`.
- `apps/mast/src-tauri/src/sink.rs:141-161`: `ended_at_ms: now_ms()` — `router.rs:71 now_ms` 를 `pub(crate)` 로 승격해
  공유.
- `apps/mast/src/types.ts`: `{ type: "exited"; code: number | null; endedAtMs: number | null }` (필수 필드 — 백엔드가
  항상 직렬화하므로 선택 필드는 거짓). 위 TS 테스트 5파일 리터럴 보정.
- 재잠금(삭제 금지, 이름은 새 메커니즘): `session_exited_marks_tab_and_keeps_session_id` → 세션을 놓고 시각을 찍는다;
  `exited_tab_close_still_kills_session` → kill 대상은 없어도 `release_tabs` 에 탭 id 가 실린다;
  `apply_osc_skips_whole_delta_for_exited_tab`·`startup_timeout_does_not_touch_an_exited_tab` → setup 직후
  `pty_session == None` 을 먼저 assert; `respawn_revives_a_tab_that_died_at_runtime` → `(None, Exited{..})`;
  **추가**: (c) 가 `Some(stale)` 인 exited 탭도 kill 후 스폰한다; `sanitize_revives_exited_terminal_tabs` →
  `sanitize_keeps_exited_terminal_tabs`, NotStarted 판(`:702`)은 유지.
- 확인: `rg "TerminalStatus|SessionExited" apps/spike` 는 비어 있다(확인 완료 — spike 는 코어 상태 타입을 쓰지 않는다).

### 1b — 코어 신규 표면 [low · 순수 추가]

- `replay.rs`: `pub fn clear(&mut self)` — chunks·total 만 비운다, `evicted` 불변.
- `session.rs`: `pub fn take_record(&self) -> Option<Vec<u8>>` — 한 lock 안에서 `if inner.alive { return None }`,
  snapshot 을 뜨고 `replay.clear()`; **snapshot 이 비어 있으면 `Some(Vec::new())`**(preamble 만 남는 기록은 빈 화면
  파일이라 만들지 않는다 — 글루의 "비어 있으면 기록 삭제" 판정이 여기에 건다), 아니면 preamble + snapshot. 술어는 **`alive`** (`killed` 는 kill() 이 자식 생존 중에도 올린다). flow
  리셋·notify 없음. rustdoc 에 리더 tail 경합 한 문장. `SessionStats.replay_bytes: usize`(= `replay.len()`).
  `SessionManager::ids() -> Vec<SessionId>`(오름차순, 레지스트리 lock 만).
- `record.rs`(신규) + `lib.rs`: `RecordStore { dir }` — `new`, `path(tab)`, `write(tab, &[u8])`(create_dir_all →
  `tab-<id>.bin.tmp` → rename), `read(tab) -> io::Result<Option<Vec<u8>>>`(NotFound → None, > 4 MiB → Err),
  `remove(tab)`(없으면 Ok), `sweep(keep: &HashSet<TabId>) -> io::Result<SweepReport { removed, failed }>`(`tab-<u64>.bin`
  으로 파싱되는 것만 판정, 잔여 `*.tmp` 는 이름 무관 삭제, 파싱 안 되는 `.bin` 은 무시; 항목 하나의 삭제 실패로
  멈추지 않고 세어서 돌려준다 — Windows sharing violation 대비; 디렉터리 부재는 빈 보고). `tempfile` 로 write/read/remove/sweep/미존재/
  초과 크기 테스트.
- `command.rs` 하단: `RegistryAudit { orphan_sessions, orphan_sinks, dangling_tabs: Vec<(TabId, SessionId)> }`
  (`Debug, Clone, Default, PartialEq, Eq, Serialize`, camelCase) + `audit_registries(model, session_ids, sink_ids)`.
  세 분류 각각 + 정상 상태 빈 결과 테스트.
- `tests/session_integration.rs`(unix): `take_record` 살아 있으면 None / `on_exit` 수신 후 Some / 두 번째 호출은 빈
  바이트; `replay_bytes` 가 push 뒤 증가하고 `take_record` 뒤 0.

### 2 — 글루 exit 경로 [high · Linux 실행 검증 불가]

- `state.rs`: `AppState.records: Arc<RecordStore>`, `AppState.last_audit: Mutex<RegistryAudit>`, `SinkRegistry::ids()`.
- `sink.rs`: `TerminalSink { tab: Option<TabId>, .. }`, `new(session, tab, app, router)`; `on_exit` 를 D2 순서로 재작성
  (①②③ 명시적 `drop(dispatcher)` ④). `tab` 이 None 인 exit 은 `winlog!`. ② 의 "빈 바이트" 는 `take_record` 가 `Some(빈 Vec)` 을 돌려준 경우다(1b 계약). 함수 주석의 "리더 스레드" 오기를 "waiter
  스레드"로.
- `host.rs`: `create_session(.., tab: Option<TabId>)`, `spawn_shell_inner` 가 `req.history_tab.map(TabId)` 전달(롤백·
  늦은 스폰 경로 불변); `TauriHost.records`; `release_tabs` 가 detached 스레드에서 각 탭 `records.remove` 후
  `release_tab_files`(cfg(windows) 함수 안에 넣지 않는다).
- `commands.rs`: `read_tab_record(state, tab: u64) -> Result<Response, String>`(async + spawn_blocking, 파일 없음 =
  빈 body, Dispatcher lock 없음); respawn 성공 시 기록 삭제는 글루 헬퍼(예 `records::forget_after_respawn`)로 —
  `commands.rs::respawn_tab` 과 `boot.rs` 웨이브 양쪽이 쓴다.
- `main.rs`: `app_data_dir()` 를 변수로 뽑아 `state.json` 과 `records/` 유도; `RecordStore` 를 `manage` 에 포함;
  **load/adopt 직후, dogfood dispatch 와 부팅 웨이브보다 앞에서** `records.sweep(keep = 전 터미널 탭 id)` 동기 실행,
  `SweepReport` 의 removed·failed 중 하나라도 0 이 아니면 `winlog!`; `generate_handler!` 에 `read_tab_record`.
- 리뷰 체크리스트(커밋 메시지에 남긴다): (1) `records.write` 가 `dispatcher.lock()` 문장보다 위, (2) `drop(dispatcher)`
  뒤에 `sinks.remove`/`sessions.remove`, (3) `on_exit` 에 `take_record` 외 세션 메서드·join 없음, (4) Drop→`kill()` 은
  `killed == true` 로 즉시 반환, (5) `TerminalSink::new` 호출 지점은 `create_session` 하나, (6) 롤백·늦은 스폰 정리
  불변, (7) `read_tab_record` 는 Dispatcher 를 만지지 않고 I/O 는 spawn_blocking 안, (8) `RecordStore::path` 는
  `tab-{u64}.bin` 포맷만, (9) `release_tabs` 의 삭제는 lock 아래 동기 실행이 아님, (10) sweep 은 첫 스폰 이전에 완료,
  (11) `records.write` 실패는 시퀀스를 끊지 않음, (12) 기록 삭제가 Close* 세 경로 전부·`SessionExited` 아님,
  (13) 양 타깃 clippy + check green.

### 3 — 프론트 기록 뷰 [med]

- `viewer-view.ts`: `TerminalRecordKind = Extract<TabKind, {type:"terminal"}> & { status: Extract<TerminalStatus,
  {type:"exited"}> }`, `ViewerKind = Exclude<TabKind, {type:"terminal"}> | TerminalRecordKind`. 상단 주석에 예외와 이유.
- `view-reconcile.ts`: `viewerKind()` 가 terminal + `ptySession === null` + `exited` 를 통과; **`planViewSync` 의
  dispose 에 "활성 워크스페이스 안이라도 terminal 이고 `ptySession === null`" 추가**(없으면 낡은 `TerminalView` 가
  `pane-view.ts:471` 의 `setVisible(true)` 로 되살아나 두 뷰가 겹친다); 상단 주석의 "둘 다일 수 없다" 근거 갱신.
  테스트: `view-reconcile.test.ts:159` 반전 + `planViewerSync` 가 같은 탭을 mount.
- `terminal-view.ts`: `liveViews` 를 `Set<{ setFontSize(size: number): void }>` 로 넓히고 `registerTerminalFontTarget`/
  `unregisterTerminalFontTarget` export; 현재 폰트·테마 접근자 export.
- `record-view.ts`(신규) `RecordView implements ViewerView`: xterm(`disableStdin: true`, `scrollback: 5000`, 터미널
  폰트·테마) + FitAddon + **자체 ResizeObserver**; 마운트 시 `readTabRecord(tab)` 1회, `TextView.load` 의 토큰 패턴;
  **바이트 → 터미널 배선은 순수 함수** `writeRecord(term: { write(data: Uint8Array | string): void }, body:
  ArrayBuffer)`(빈 body 면 영어 안내 한 줄) — 스텁 + `@xterm/headless` 로 테스트; `update()` 항상 no-op;
  `flushScroll()` no-op; `focus()` 는 xterm focus; `dispose()` 는 폰트 레지스트리 해제 + observer 해제 + `term.dispose()`.
- `pane-view.ts`: exited 배너 문구 생성을 DOM-free 순수 함수로(`shell exited (code 0) at 14:32 — Restart opens a new
  shell here`, code/endedAtMs null 이면 조각 생략) + 4조합 테스트; `placeholderText` 주석 갱신.
- `workspace-view.ts`: `ensureViewerView` 에 `case "terminal"` → `RecordView`; `focusTarget` 주석 갱신.
- `backend.ts`: `readTabRecord(tab): Promise<ArrayBuffer>`.
- 리스크 목록: in-flight attach 의 1프레임 에러(accepted).

### 4 — audit 배선·진단 [med · 잠금 순서]

- `audit.rs`(신규): `run_audit(state) -> RegistryAudit` — **Dispatcher lock 을 먼저** 잡고, 그 아래에서 `sessions.ids()`·
  `sinks.ids()`(각자 짧은 내부 lock, 복사만) 를 뜬 뒤 `audit_registries`; `dangling_tabs` 는 같은 lock 안에서
  `SessionExited { code: None, ended_at_ms: now }` 로 수리, 수리가 있으면 publish; unlock 뒤 orphan 은 `sinks.remove`·
  `sessions.remove`(kill 은 멱등 — `on_exit` ④ 나 late-spawn 정리와 겹쳐도 무해). 결과를 `last_audit` 에. 발견 시
  `winlog!`(`RegistryAudit::is_empty()` 로 판정), 아니면 `wintrace!`. 근거는 `audit_registries` rustdoc(D5).
  **4 반증에서 추가**: `on_exit` 의 ③(모델 갱신)과 ④(레지스트리 해제) 사이 창의 세션은 고아의 정의 그대로라 정상
  종료마다 오판된다 — `AppState.exits_in_flight: AtomicUsize` 를 ③ 직전에 올리고 ④ 뒤에 내리며, 검사는 Dispatcher
  lock 아래에서 **스냅샷보다 먼저** 그 값을 읽어 0 이 아니면 그 회차의 고아 판정을 버린다(dangling 판정은 불변).
  Close* 뒤의 검사는 `spawn_blocking` 안에서 돈다(lock 대기·kill 이 async 워커를 붙잡지 않게).
- 실행 지점: `on_exit` 끝, `commands.rs::dispatch` 의 Close* 성공 후(lock 해제 뒤), 부팅 웨이브 끝(`boot.rs`),
  `get_diagnostics`. 주기 타이머 없음.
- `diagnostics.rs`(신규): `Diagnostics { process { private_bytes, working_set_bytes, handle_count, thread_count }
  (Option), sessions { registered, alive, sinks, replay_bytes }, tabs { running, exited, not_started }, audit }`
  (serde camelCase). Windows 는 `reset_supervisor` 의 `mem` 을 `pub(crate)` 로 열어 재사용 + `GetProcessHandleCount`
  + Toolhelp thread; non-Windows 스텁. `get_diagnostics` 커맨드, `backend.ts::getDiagnostics`, `window.__mast.
  diagnostics()`. `winlog!("diag: …")` 는 부팅 웨이브 끝 / audit 발견 시 / reset supervisor 임계 트리거.

### 5 — Saver 슬롯 [med · 동시성]

- `persist.rs`: `Arc<SaverShared { slot: Mutex<SaverSlot>, cond: Condvar }>`, `SaverSlot { pending, deadline, flush_req,
  flush_done, closed, worker_dead }`. `schedule` 은 교체(`None→Some` 일 때만 deadline 고정). worker 는 **lock 안에서
  `pending.take()` 만** 하고 lock 밖에서 `save_atomic`; flush 는 `pending` 이 `None` 일 때만 `flush_done = flush_req`.
  worker Drop 가드가 `worker_dead` + notify; `PoisonError::into_inner`. 기존 테스트 3개 유지 + "대기 clone ≤ 1",
  "debounce 는 첫 schedule 에 고정", "flush 는 그 이전 schedule 전부를 포함" 추가.

### 6 — 문서·버전 [low]

- `docs/adr/0018-exited-tab-as-terminal-record.md`: D1~D7, exit 5단계와 근거, 파일 수명 4규칙, audit 규칙·잠금 순서,
  진단, Saver, accepted limits(tail 유실 두 종류, 평문 기록, 탭당 ≤ ~1 MiB, close↔exit 경합의 고아 파일은 부팅
  sweep 이 덮음, 1~3단계 창의 blank, in-flight attach 1프레임, **절전 뒤 탭별 Restart — 일괄 되살리기는 후속**).
- ADR-0010·0013 상단 "Amended by ADR-0018" 한 줄. CLAUDE.md: 백로그 4항목 갱신 + ADR-0010 항목의 "restore normalizes
  Exited → Running" 반쪽 정정 + 후속 항목(일괄 Restart) 한 줄. `docs/SETTINGS.md` 데이터 경로 절(`records/` 평문).
  `docs/WINDOWS-BUILD.md` §10 v0.3.25. 버전 0.3.25 두 파일 + `Cargo.lock`.

## 3. 검증

자동: 레포 `## Gates` 전부(청크마다). 사용자 실측(WINDOWS-BUILD §10 v0.3.25): `exit` → 기록 뷰 + 배너(code·시각) →
`get_stats`/`diagnostics` 에서 세션 소멸 → Restart → 새 셸 + 기록 삭제; `wsl --shutdown` 뒤 앱 재시작 → 기록 유지,
Running 탭만 재스폰; CloseTab 뒤 `records/` 삭제; 강제 종료 뒤 sweep 로그; `mast.log` `diag:` 줄; 폰 409; `Ctrl+=`
기록 뷰 줌.
