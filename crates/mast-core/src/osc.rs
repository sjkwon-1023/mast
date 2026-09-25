//! 터미널 제어 시퀀스 감지기 — OSC 와 DEC private mode(`CSI ? Pm h/l`).
//!
//! PTY 출력 스트림에서 OSC 0/7/9/777 시퀀스를 증분(incremental)으로 감지한다.
//! 감지 전용이다 — 입력 바이트를 변형하거나 소비 표시하지 않으며, 호출자는 입력을
//! 그대로 프론트엔드에 passthrough 한다. 계약: `docs/plans/spike-plan.md` 4.1장.
//! OSC 2(아이콘+창 제목)는 ConPTY 가 제목을 재인코딩할 가능성에 대비해 OSC 0 과 동일하게
//! `Osc0Title` 로 취급한다.
//!
//! # 왜 CSI 인식이 "OSC" 스캐너 안에 있나
//!
//! 이름과 달리 이 모듈은 OSC 전용이 아니다. DEC private mode(`ESC [ ? … h/l`)와
//! 리셋(RIS·DECSTR)은 **같은 바이트 스트림의 같은 ESC 상태 머신**을 지나간다 —
//! 시퀀스가 청크 경계에서 잘리는 처리도, CAN/SUB 중단 처리도 OSC 와 한 글자도
//! 다르지 않다. 두 번째 스캐너를 세우면 그 셋을 전부 복제하게 되고, 두 스캐너가
//! 같은 바이트에 대해 서로 다른 상태를 갖는 순간이 새 버그 표면이 된다.
//! 여기서 나오는 모드 이벤트를 **누가 소비하는지**(sink 가 아니라 세션)와 어떤
//! 모드를 추적할지는 [`crate::session`] 의 정책이다 — 이 모듈은 감지만 한다.

use crate::model::{AgentKind, AgentSession};

/// 문자열은 payload 를 UTF-8 lossy 변환한 결과다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscEvent {
    /// OSC 0 — 창 제목 설정.
    Osc0Title(String),
    /// OSC 7 — 현재 작업 디렉터리 (`file://host/path` URI).
    Osc7Cwd(String),
    /// OSC 9 — 단순 알림 (iTerm2/ConEmu 계열).
    Osc9Notify(String),
    /// OSC 777 — `notify;title;body` 형식 알림 (urxvt 계열).
    Osc777Notify { title: String, body: String },
    /// OSC 777 — `mast-send;<target>;<base64>` 형식의 **pane 간 텍스트 전송**
    /// 요청 (에이전트 채널 — `scripts/wsl/skills/mast-send/SKILL.md`).
    ///
    /// 알림과 달리 상태 델타가 아니라 **액션**이다: 글루가 코얼레싱 배치에 넣지
    /// 않고 즉시 대상 세션의 stdin 에 쓴다. 여기서는 필드를 나누기만 하고,
    /// base64 디코드·상한 검사는 [`crate::send`] 가, 대상 해석은
    /// [`crate::command::Dispatcher::resolve_send_target`] 가 맡는다.
    ///
    /// 세 번째 필드가 아예 없는 payload(`777;mast-send;build`)는 형식 불일치라
    /// 이벤트가 되지 않는다 — 빈 전송을 조용히 성공시키지 않는다.
    ///
    /// # 보안
    ///
    /// 같은 머신에서 이 PTY 로 바이트를 흘릴 수 있는 **어떤 터미널 프로그램이든**
    /// 이 시퀀스로 다른 pane 에 입력을 넣을 수 있다. 본인 머신·협력 에이전트를
    /// 전제한 의도된 기능이며, 오발사 가드는 상한(32KiB)·유일 매치·자기 제외·
    /// 워크스페이스 격리 넷뿐이다 — 권한 경계가 아니다.
    Osc777Send { target: String, text_b64: String },
    /// OSC 777 — `mast-query;<kind>;<base64>` 형식의 **질의** 요청 (에이전트
    /// 채널). `kind` 는 질의 종류(예: `list-tabs`), 세 번째 필드는 **회신 파일
    /// 경로**의 base64 다 — 경로 검증·디코드는 [`crate::send::decode_reply_path`]
    /// 가 맡는다.
    ///
    /// 전송(`mast-send`)과 같은 규율이다: 상태 델타가 아니라 **액션**이라
    /// 코얼레싱 배치에 담기지 않고, 두 필드가 모두 있어야만 이벤트가 된다
    /// (`777;mast-query;list-tabs` 는 형식 불일치로 떨어진다 — 회신 주소 없는
    /// 질의를 조용히 성공시키지 않는다).
    Osc777Query { kind: String, reply_b64: String },
    /// OSC 777 — `mast-started`. 셸 래퍼가 실행되자마자 내는 시작 표식이며 필드가
    /// 없다 (존재 자체가 신호다).
    ///
    /// 이 표식이 따로 필요한 이유는 **"출력이 있다 = 셸이 떴다"가 성립하지 않기**
    /// 때문이다. ConPTY 는 커서 질의(`ESC[6n`)를 출력 스트림에 스스로 주입하고
    /// (ADR-0004), 실기 장애에서 셸이 한 바이트도 내지 못한 채 그 4바이트만 흐른
    /// 기록이 있다(`terminal-view.ts` attach 주석). 래퍼 첫 줄의 테마 시퀀스도 근거가
    /// 못 된다 — OSC 10/11 set 은 conhost 가 handled 로 소비해 여기까지 오지 않는다
    /// (`host.rs::bash_argv` rustdoc). 반면 OSC 777 은 conhost 가 모르는 시퀀스라
    /// 그대로 통과하며, 그 통과는 알림 파이프라인으로 이미 실기 검증됐다(ADR-0006).
    Osc777Started,
    /// OSC 777 — `mast-agent;<base64>` 형식의 **에이전트 세션 메타**. Claude/Codex
    /// hook 이 자기 탭의 transcript 경로와 세션 id 를 알려 주는 채널이며, 세 번째
    /// 필드는 표준 base64(UTF-8 JSON)다.
    ///
    /// 전송·질의와 같은 규율 — 세 번째 필드가 없으면 형식 불일치로 이벤트가 되지
    /// 않는다. 검증 규칙은 이 모듈의 `parse_agent_session` 하나에 모아 두었다:
    /// 하나라도 실패하면 이벤트도, 코얼레싱 슬롯도 만들어지지 않는다.
    Osc777Agent(AgentSession),
    /// OSC 10/11 — 전경/배경색 **질의**(`ESC ] 10 ; ? ST`). `code` 는 10 = 전경,
    /// 11 = 배경이다. 앱(글루)이 우리 테마 값으로 **직접 응답**한다
    /// (`apps/mast/src-tauri/src/sink.rs`).
    ///
    /// # 왜 우리가 답하나 (판단 반전의 근거)
    ///
    /// 종전 판단은 "응답기는 역효과"였다 — conhost 가 질의를 가로채 자기 색
    /// 테이블로 먼저 답하므로(ms/terminal#17729) 우리가 또 답하면 중복 응답이
    /// 되고, 그래서 `host.rs` 의 THEME_SYNC 로 conhost 의 테이블을 **미리 우리
    /// 값으로 세팅**하는 쪽만 택했다. **2026-08-11 실기 probe 가 그 전제를
    /// 뒤집었다: OSC 11 질의에 아무도 응답하지 않는다** (conhost 도, xterm 도).
    /// Codex 는 배경색을 못 받으면 입력창 배경을 아예 그리지 않으므로, 그 미응답이
    /// 실기 스크린샷의 "입력칸 구분 없음"으로 남는다.
    ///
    /// 그래서 계약을 뒤집었다: **질의가 conhost 를 통과해 우리 출력 스트림까지
    /// 도달하면** 그때 우리가 답한다. 도달하지 않으면(= conhost 가 삼키면) 이
    /// 이벤트 자체가 발생하지 않아 아무 일도 일어나지 않는다 — 무해한 조건부
    /// 응답이다. 어느 쪽이었는지는 글루의 진단 로그로 판별한다 (sink.rs).
    ///
    /// # set 형태는 감지하지 않는다
    ///
    /// `rest` 가 정확히 `"?"` 일 때만 이벤트다. 색값을 싣는 set 형태
    /// (`10;#cccccc`)는 종전대로 미감지 — 그대로 xterm 까지 passthrough 된다.
    /// `host.rs` 의 THEME_SYNC 가 내보내는 set 이 이 경로로 흘러들어도 값이
    /// TERMINAL_THEME 와 **같으므로** xterm 이 자기 테마를 같은 값으로 다시
    /// 세팅할 뿐 무해하다.
    OscColorQuery { code: u8 },
    /// `CSI ? Pm h` (DECSET) / `CSI ? Pm l` (DECRST) — 실행 중인 프로그램이 켜고
    /// 끄는 **DEC private mode**. `modes` 는 한 시퀀스가 담은 모드 번호 전부이고
    /// (`?1000;1006h` → `[1000, 1006]`), `set` 이 `h`(켬) / `l`(끔)이다.
    ///
    /// # 왜 감지하나
    ///
    /// 이 모드들은 프론트의 xterm 인스턴스 안에만 산다. 재-attach(워크스페이스
    /// 전환·F5·webview 리로드)는 새 Terminal 을 만들고 replay 바이트만 다시
    /// 흘리므로, 모드를 켠 시퀀스가 replay 창 밖으로 밀려난 장수 TUI 는 모드를
    /// 통째로 잃는다 — 실기에서 bracketed paste(2004)가 그렇게 꺼져 여러 줄
    /// 붙여넣기의 첫 줄이 제출됐다. 그래서 세션이 값을 들고 있다가 재-attach
    /// preamble 로 다시 세운다 ([`crate::session::PtySession::reattach`]).
    ///
    /// 감지 대상은 **private(`?`) 형태의 `h`/`l` 뿐**이다. 질의(`?…$p`)·
    /// 저장/복원(`?…s`/`?…r`)·비-private CSI 는 이벤트가 되지 않는다.
    DecPrivateMode { modes: Vec<u16>, set: bool },
    /// `ESC c`(RIS) 또는 `CSI … ! p`(DECSTR) — 단말의 모드가 기본값으로 돌아갔다.
    /// 추적 중인 값을 그대로 들고 있으면 재-attach 가 이미 꺼진 마우스 트래킹
    /// 같은 것을 되살리므로, 세션은 이 이벤트에서 추적 맵을 손본다.
    ///
    /// `soft` 는 **되돌아간 범위**를 가른다. RIS(`soft: false`)는 단말 전체를
    /// 초기화하지만 DECSTR(`soft: true`)은 일부 모드만 건드린다 — 어느 모드가
    /// 그 일부인지는 소비자(터미널 구현)의 사실이라 [`crate::session`] 이 안다.
    TerminalReset { soft: bool },
}

/// payload 상한 (bytes). 초과하는 시퀀스는 통째로 폐기한다 — 악성/폭주 입력 방어.
/// 64KiB 인 이유: `mast-send` 의 텍스트 계약이 32KiB(디코드 후)이고 base64
/// 팽창(4/3) + 헤더를 더하면 payload 가 ~44KiB 까지 자란다 — 4096 이면 문서화된
/// 상한이 실효 ~3KB 로 무음 축소된다. 버퍼는 세션당 진행 중 시퀀스 1개뿐이라
/// 메모리 상한은 세션 수 × 64KiB 로 유계다.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// CSI 파라미터·중간 바이트 상한. 예산의 단위는 모드 하나당 약 5바이트다
/// (`?`·네 자리 숫자·`;`) — 128 이면 DECSET 한 시퀀스에 모드 25개쯤이 들어오는
/// 셈이고, 실제 emitter 가 한 번에 나열하는 것은 많아야 서넛이다(마우스 트래킹을
/// 한 줄에 켜는 `?1000;1002;1003;1006` 이 20 바이트). 상한을 넘으면 그 시퀀스는
/// 통째로 버려진다 — 즉 모드를 추적하지 않던 이 변경 이전 동작으로 떨어지므로
/// 실패 방향이 안전하다.
const MAX_CSI_BYTES: usize = 128;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
/// CAN — 실터미널(xterm/ConPTY)은 이 제어문자에서 진행 중인 OSC를 중단한다.
const CAN: u8 = 0x18;
/// SUB — CAN과 동일하게 시퀀스를 중단시킨다.
const SUB: u8 = 0x1a;

/// 상태가 `feed` 호출 사이에 유지되므로 한 시퀀스가 여러 청크에 걸쳐 나뉘어
/// 와도 인식된다.
enum State {
    /// 일반 텍스트 — ESC 를 기다린다.
    Ground,
    /// ESC 직후 — 다음 바이트로 시퀀스 종류를 판별한다.
    Esc,
    /// `ESC [` 이후 파라미터·중간 바이트 수집 중 — 최종 바이트(0x40..=0x7E)에서 끝난다.
    Csi,
    /// `ESC ]` 이후 payload 수집 중.
    Collect,
    /// payload 수집 중 ESC 를 봄 — 다음이 `\` 면 ST 종결.
    CollectEsc,
}

pub struct OscScanner {
    state: State,
    buf: Vec<u8>,
    /// payload 가 상한을 넘어 이번 시퀀스를 폐기하기로 결정한 상태.
    /// 종결자까지는 계속 소비하되 이벤트를 내지 않는다.
    overflow: bool,
}

impl OscScanner {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            buf: Vec::new(),
            overflow: false,
        }
    }

    /// bytes 를 순회하며 완성된 이벤트를 반환한다. 감지 전용 — 입력을 변형하지
    /// 않는다(passthrough). 미완성 시퀀스는 내부 상태로 유지되어 다음 `feed` 에서
    /// 이어서 처리된다.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        for &b in bytes {
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Esc;
                    }
                }
                State::Esc => {
                    if b == b']' {
                        self.begin_collect();
                    } else if b == b'[' {
                        self.begin_csi();
                    } else if b == b'c' {
                        // RIS — 파라미터가 없는 2바이트 시퀀스라 여기서 끝난다.
                        events.push(OscEvent::TerminalReset { soft: false });
                        self.state = State::Ground;
                    } else if b == ESC {
                        // ESC 연속 — 마지막 ESC 기준으로 다시 판별한다.
                        self.state = State::Esc;
                    } else {
                        // 감지 대상이 아닌 ESC 시퀀스(문자셋 지정 등) — 무시.
                        self.state = State::Ground;
                    }
                }
                State::Csi => {
                    match b {
                        // OSC 와 같은 규율 — 실터미널은 이 제어문자에서 진행 중인
                        // 시퀀스를 버린다.
                        CAN | SUB => {
                            self.discard();
                            self.state = State::Ground;
                        }
                        ESC => {
                            self.discard();
                            self.state = State::Esc;
                        }
                        // 파라미터·중간 바이트.
                        0x20..=0x3f => {
                            if self.buf.len() >= MAX_CSI_BYTES {
                                self.overflow = true;
                                self.buf.clear();
                            } else {
                                self.buf.push(b);
                            }
                        }
                        // 최종 바이트 — 여기서 시퀀스가 끝난다.
                        0x40..=0x7e => {
                            if let Some(ev) = self.finish_csi(b) {
                                events.push(ev);
                            }
                        }
                        // 그 밖(C0 제어문자·DEL)은 실터미널이 시퀀스 도중에도 그대로
                        // 실행하고 CSI 는 이어진다 — 수집하지 않고 지나간다.
                        _ => {}
                    }
                }
                State::Collect => {
                    if b == BEL {
                        if let Some(ev) = self.finish() {
                            events.push(ev);
                        }
                    } else if b == ESC {
                        self.state = State::CollectEsc;
                    } else if b == CAN || b == SUB {
                        // 실터미널 동작에 맞춰 시퀀스를 중단한다 — 종결자 없는 깨진
                        // OSC 가 이후 일반 출력을 payload 로 계속 삼키는 것을 막는다.
                        self.discard();
                        self.state = State::Ground;
                    } else if self.buf.len() >= MAX_PAYLOAD_BYTES {
                        // 상한 초과 — 이번 시퀀스는 폐기 확정. 메모리를 잡아두지 않도록
                        // 지금까지 모은 payload 도 버린다.
                        self.overflow = true;
                        self.buf.clear();
                    } else {
                        self.buf.push(b);
                    }
                }
                State::CollectEsc => {
                    if b == b'\\' {
                        // ST(`ESC \`) 종결.
                        if let Some(ev) = self.finish() {
                            events.push(ev);
                        }
                    } else if b == b']' {
                        // OSC 도중 새 OSC 시작 — 기존 시퀀스는 미종결로 폐기.
                        self.begin_collect();
                    } else if b == b'[' {
                        // 같은 규율의 CSI 판 — 종결되지 않은 OSC 뒤에 붙은 DECSET 을
                        // 놓치지 않는다.
                        self.begin_csi();
                    } else if b == b'c' {
                        // 같은 이유로 RIS 도 놓치지 않는다. 미종결 OSC 는 폐기하고
                        // 리셋만 보고한다.
                        self.discard();
                        events.push(OscEvent::TerminalReset { soft: false });
                        self.state = State::Ground;
                    } else if b == ESC {
                        // 기존 시퀀스 폐기, 새 ESC 시퀀스 판별로 진입.
                        self.discard();
                        self.state = State::Esc;
                    } else {
                        // ESC + 기타 — OSC 가 중단되고 다른 시퀀스가 시작됐다. 폐기.
                        self.discard();
                        self.state = State::Ground;
                    }
                }
            }
        }
        events
    }

    fn begin_collect(&mut self) {
        self.buf.clear();
        self.overflow = false;
        self.state = State::Collect;
    }

    fn begin_csi(&mut self) {
        self.buf.clear();
        self.overflow = false;
        self.state = State::Csi;
    }

    /// 버퍼를 `take` 하지 않고 빌려 쓴 뒤 `clear` 하는 것은 **hot path 라서**다.
    /// 출력의 거의 모든 SGR·커서 이동 CSI 가 이 분기를 지나가므로, `take` 로
    /// 소유권을 넘겼다가 드롭하면 시퀀스마다 malloc/free 가 한 번씩 붙는다.
    /// `clear` 는 용량을 남기니 두 번째 시퀀스부터는 할당이 없다. OSC 쪽
    /// [`finish`](Self::finish)는 시퀀스 빈도가 낮고 payload 가 64KiB 까지
    /// 자랄 수 있어 반대로 버리는 편이 낫다 — 그래서 둘이 다르다.
    fn finish_csi(&mut self, final_byte: u8) -> Option<OscEvent> {
        let event = if self.overflow {
            None
        } else {
            parse_csi(&self.buf, final_byte)
        };
        self.buf.clear();
        self.overflow = false;
        self.state = State::Ground;
        event
    }

    fn discard(&mut self) {
        self.buf.clear();
        self.overflow = false;
    }

    fn finish(&mut self) -> Option<OscEvent> {
        let overflowed = self.overflow;
        let payload = std::mem::take(&mut self.buf);
        self.overflow = false;
        self.state = State::Ground;
        if overflowed {
            return None;
        }
        parse_payload(&payload)
    }
}

impl Default for OscScanner {
    fn default() -> Self {
        Self::new()
    }
}

/// 완성된 CSI(`ESC [` 와 최종 바이트 사이의 파라미터·중간 바이트 + 최종 바이트)를
/// 이벤트로 분류한다. 감지 대상이 아닌 CSI 는 None — SGR·커서 이동 등 대다수가
/// 여기로 떨어지고, 그대로 passthrough 된다.
fn parse_csi(params: &[u8], final_byte: u8) -> Option<OscEvent> {
    match final_byte {
        // DECSET/DECRST — private 접두사(`?`)가 붙은 형태만이다. `2J`(비-private)나
        // `?2004$p`(DECRQM — 중간 바이트 `$` 가 붙어 최종 바이트가 `p`)는 여기 오지
        // 않거나 아래 `!p` 검사에서 떨어진다.
        b'h' | b'l' => {
            let digits = params.strip_prefix(b"?")?;
            if digits.is_empty() {
                return None;
            }
            let mut modes = Vec::new();
            for part in digits.split(|&b| b == b';') {
                // 빈 파라미터·비숫자·u16 범위 초과는 시퀀스 전체를 미감지로
                // 떨어뜨린다 — 절반만 해석한 모드 목록으로 재-attach preamble 을
                // 만드는 것보다 아무것도 안 하는 쪽이 안전하다.
                if part.is_empty() || !part.iter().all(u8::is_ascii_digit) {
                    return None;
                }
                modes.push(std::str::from_utf8(part).ok()?.parse::<u16>().ok()?);
            }
            Some(OscEvent::DecPrivateMode {
                modes,
                set: final_byte == b'h',
            })
        }
        b'p' if is_decstr_params(params) => Some(OscEvent::TerminalReset { soft: true }),
        _ => None,
    }
}

/// DECSTR 의 파라미터부인지 — 숫자·`;` 뒤에 중간 바이트 `!` 하나로 끝나야 한다.
/// 파라미터 없는 `CSI ! p` 뿐 아니라 `CSI 0 ! p` 도 DECSTR 이다: xterm 은 중간
/// 바이트 `!` 와 최종 바이트 `p` 조합만으로 핸들러를 고르고 파라미터는 보지 않는다
/// (`InputHandler.ts` 의 `registerCsiHandler({ intermediates: '!', final: 'p' })`).
fn is_decstr_params(params: &[u8]) -> bool {
    match params.strip_suffix(b"!") {
        Some(head) => head.iter().all(|b| b.is_ascii_digit() || *b == b';'),
        None => false,
    }
}

/// 완성된 payload(`ESC ]` 와 종결자 사이 바이트)를 이벤트로 파싱한다.
/// 알 수 없는 코드·형식 불일치는 None (감지 대상 아님).
fn parse_payload(payload: &[u8]) -> Option<OscEvent> {
    let text = String::from_utf8_lossy(payload);
    let (code, rest) = match text.split_once(';') {
        Some((code, rest)) => (code, rest),
        None => (text.as_ref(), ""),
    };
    match code {
        // "2" 는 OSC 0(아이콘+제목)의 부분집합인 "창 제목만" 코드 — ConPTY 가 제목을
        // 이 코드로 재인코딩할 가능성에 대비해 별칭으로 취급한다(enum variant 는 불변).
        "0" | "2" => Some(OscEvent::Osc0Title(rest.to_string())),
        "7" => Some(OscEvent::Osc7Cwd(rest.to_string())),
        "9" => Some(OscEvent::Osc9Notify(rest.to_string())),
        // 색상 **질의**만 이벤트다 (`10;?`·`11;?`) — 근거는 OscColorQuery rustdoc.
        // set 형태(`10;#cccccc`)는 여기서 걸러져 종전대로 passthrough 된다.
        "10" if rest == "?" => Some(OscEvent::OscColorQuery { code: 10 }),
        "11" if rest == "?" => Some(OscEvent::OscColorQuery { code: 11 }),
        "777" => {
            // urxvt 계열: `777;notify;title;body`. body 안의 `;` 는 body 에 포함.
            // `mast-send` 는 mast 자체 확장(pane 간 전송)이고, 그 외 kind 는
            // 감지 대상이 아니다 — 기존 `notify` 계약은 그대로다.
            let mut parts = rest.splitn(3, ';');
            match parts.next().unwrap_or("") {
                "notify" => {
                    let title = parts.next().unwrap_or("").to_string();
                    let body = parts.next().unwrap_or("").to_string();
                    Some(OscEvent::Osc777Notify { title, body })
                }
                "mast-send" => {
                    // 두 필드가 모두 있어야 한다 (`?`) — 텍스트 필드가 없는 요청은
                    // 형식 불일치로 떨어뜨린다. base64 표준 알파벳에는 `;` 가 없어
                    // 세 번째 필드가 그대로 payload 다.
                    let target = parts.next()?.to_string();
                    let text_b64 = parts.next()?.to_string();
                    Some(OscEvent::Osc777Send { target, text_b64 })
                }
                "mast-query" => {
                    // `mast-send` 와 동일한 규율 — 두 필드 필수(`?`). 회신 경로
                    // 필드가 없는 질의는 답을 받을 곳이 없으므로 이벤트가 되지 않는다.
                    let kind = parts.next()?.to_string();
                    let reply_b64 = parts.next()?.to_string();
                    Some(OscEvent::Osc777Query { kind, reply_b64 })
                }
                // 전송·질의와 달리 필드를 요구하지 않는다 — 표식은 도착 사실만으로
                // 의미가 끝나고, 뒤에 무엇이 붙어도 그 사실은 변하지 않는다.
                "mast-started" => Some(OscEvent::Osc777Started),
                // 세 번째 필드(payload)가 없으면 형식 불일치 — 빈 메타를 조용히
                // 기록하지 않는다. base64 표준 알파벳에는 `;` 가 없어 그대로 payload 다.
                "mast-agent" => {
                    let session_b64 = parts.next()?;
                    parse_agent_session(session_b64).map(OscEvent::Osc777Agent)
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// `mast-agent` payload 상한 (bytes) — 디코드한 JSON 의 크기.
const MAX_AGENT_PAYLOAD_BYTES: usize = 8 * 1024;

/// `session` 길이 상한 (chars).
const MAX_AGENT_SESSION_CHARS: usize = 128;

/// `transcript` 길이 상한 (bytes).
const MAX_AGENT_TRANSCRIPT_BYTES: usize = 4096;

/// `mast-agent` 의 세 번째 필드(base64 UTF-8 JSON)를 검증해 [`AgentSession`] 으로
/// 바꾼다. **하나라도 실패하면 `None`** — 호출자는 이벤트를 만들지 않고, 글루의
/// 코얼레싱 배치는 값이 있는 필드만 반영하므로 슬롯도 만들어지지 않는다 (구 코어가
/// 이 kind 를 통째로 무시하는 것과 같은 결과).
///
/// 검증 순서: 디코드 [`decode_send_text`](crate::send::decode_send_text) → ≤ 8 KiB →
/// UTF-8 JSON 파서 → JSON **객체** → `v == 1` → `agent` ∈ {claude, codex} →
/// `session` 1~128자 `[A-Za-z0-9._:-]` → `transcript` ≤ 4096 bytes +
/// [`validate_linux_path`](crate::wslpath::validate_linux_path).
/// 모르는 추가 키는 무시한다 (전방 호환 — 뒤에 필드가 늘어도 구 코어가 산다).
fn parse_agent_session(session_b64: &str) -> Option<AgentSession> {
    let bytes = crate::send::decode_send_text(session_b64).ok()?;
    if bytes.len() > MAX_AGENT_PAYLOAD_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let object = value.as_object()?;
    if object.get("v")?.as_u64()? != 1 {
        return None;
    }
    let agent = match object.get("agent")?.as_str()? {
        "claude" => AgentKind::Claude,
        "codex" => AgentKind::Codex,
        _ => return None,
    };
    let session_id = object.get("session")?.as_str()?;
    if session_id.is_empty()
        || session_id.chars().count() > MAX_AGENT_SESSION_CHARS
        || !session_id.bytes().all(is_agent_session_char)
    {
        return None;
    }
    let transcript_path = object.get("transcript")?.as_str()?;
    if transcript_path.len() > MAX_AGENT_TRANSCRIPT_BYTES {
        return None;
    }
    crate::wslpath::validate_linux_path(transcript_path).ok()?;
    Some(AgentSession {
        agent,
        session_id: session_id.to_owned(),
        transcript_path: transcript_path.to_owned(),
    })
}

/// `session` 허용 문자 — `[A-Za-z0-9._:-]`. 경로 구분자·공백·셸 문자를 메타에 실을
/// 수 없고, ASCII 밖 문자도 거부된다 (길이 상한이 bytes 가 아니라 chars 인 것과 무관).
fn is_agent_session_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(bytes: &[u8]) -> Vec<OscEvent> {
        OscScanner::new().feed(bytes)
    }

    #[test]
    fn osc0_title_bel() {
        assert_eq!(
            scan(b"\x1b]0;my title\x07"),
            vec![OscEvent::Osc0Title("my title".into())]
        );
    }

    #[test]
    fn osc0_title_st() {
        assert_eq!(
            scan(b"\x1b]0;my title\x1b\\"),
            vec![OscEvent::Osc0Title("my title".into())]
        );
    }

    #[test]
    fn osc2_title_parsed_as_osc0title() {
        // ConPTY 가 제목을 OSC 2 로 재인코딩할 가능성에 대비한 별칭.
        assert_eq!(
            scan(b"\x1b]2;my title\x07"),
            vec![OscEvent::Osc0Title("my title".into())]
        );
    }

    #[test]
    fn osc0_title_still_parsed_after_osc2_alias_added() {
        assert_eq!(
            scan(b"\x1b]0;another title\x1b\\"),
            vec![OscEvent::Osc0Title("another title".into())]
        );
    }

    #[test]
    fn osc7_cwd_st() {
        assert_eq!(
            scan(b"\x1b]7;file://host/home/user\x1b\\"),
            vec![OscEvent::Osc7Cwd("file://host/home/user".into())]
        );
    }

    #[test]
    fn osc7_cwd_bel() {
        assert_eq!(
            scan(b"\x1b]7;file://h/p\x07"),
            vec![OscEvent::Osc7Cwd("file://h/p".into())]
        );
    }

    #[test]
    fn osc9_notify_bel() {
        assert_eq!(
            scan(b"\x1b]9;build done\x07"),
            vec![OscEvent::Osc9Notify("build done".into())]
        );
    }

    #[test]
    fn osc9_notify_st() {
        assert_eq!(
            scan(b"\x1b]9;hello\x1b\\"),
            vec![OscEvent::Osc9Notify("hello".into())]
        );
    }

    #[test]
    fn osc777_notify_bel() {
        assert_eq!(
            scan(b"\x1b]777;notify;Title;Body text\x07"),
            vec![OscEvent::Osc777Notify {
                title: "Title".into(),
                body: "Body text".into()
            }]
        );
    }

    #[test]
    fn osc777_notify_st() {
        assert_eq!(
            scan(b"\x1b]777;notify;T;B\x1b\\"),
            vec![OscEvent::Osc777Notify {
                title: "T".into(),
                body: "B".into()
            }]
        );
    }

    #[test]
    fn osc777_body_keeps_semicolons() {
        // body 안의 세미콜론은 분리하지 않고 body 에 포함해야 한다.
        assert_eq!(
            scan(b"\x1b]777;notify;T;a;b;c\x07"),
            vec![OscEvent::Osc777Notify {
                title: "T".into(),
                body: "a;b;c".into()
            }]
        );
    }

    #[test]
    fn osc777_non_notify_kind_ignored() {
        assert_eq!(scan(b"\x1b]777;other;T;B\x07"), vec![]);
    }

    #[test]
    fn osc777_send_parsed() {
        assert_eq!(
            scan(b"\x1b]777;mast-send;build;Y2FyZ28gdGVzdAo=\x07"),
            vec![OscEvent::Osc777Send {
                target: "build".into(),
                text_b64: "Y2FyZ28gdGVzdAo=".into()
            }]
        );
    }

    #[test]
    fn osc777_send_st_terminated_and_split() {
        // ST 종결 + 청크 분할에서도 같은 계약 (알림과 같은 스캐너 경로).
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b]777;mast-se"), vec![]);
        assert_eq!(
            s.feed(b"nd;my Tab;aGk=\x1b\\"),
            vec![OscEvent::Osc777Send {
                target: "my Tab".into(),
                text_b64: "aGk=".into()
            }]
        );
    }

    #[test]
    fn osc777_send_without_text_field_ignored() {
        // 대상만 있고 텍스트 필드가 없으면 이벤트가 되지 않는다 (빈 전송 금지).
        assert_eq!(scan(b"\x1b]777;mast-send;build\x07"), vec![]);
        assert_eq!(scan(b"\x1b]777;mast-send\x07"), vec![]);
    }

    #[test]
    fn osc777_send_keeps_trailing_semicolons_in_text_field() {
        // 세 번째 필드는 끝까지 텍스트다 — base64 에 `;` 는 없으므로 이 경우는
        // 디코드 단계에서 거부된다(파서는 자르지 않는다).
        assert_eq!(
            scan(b"\x1b]777;mast-send;t;aGk=;x\x07"),
            vec![OscEvent::Osc777Send {
                target: "t".into(),
                text_b64: "aGk=;x".into()
            }]
        );
    }

    #[test]
    fn osc777_query_parsed() {
        assert_eq!(
            scan(b"\x1b]777;mast-query;list-tabs;L3RtcC9yZXBseS5qc29u\x07"),
            vec![OscEvent::Osc777Query {
                kind: "list-tabs".into(),
                reply_b64: "L3RtcC9yZXBseS5qc29u".into()
            }]
        );
    }

    #[test]
    fn osc777_query_st_terminated_and_split() {
        // ST 종결 + 청크 분할에서도 같은 계약 (전송과 같은 스캐너 경로).
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b]777;mast-qu"), vec![]);
        assert_eq!(
            s.feed(b"ery;list-tabs;aGk=\x1b\\"),
            vec![OscEvent::Osc777Query {
                kind: "list-tabs".into(),
                reply_b64: "aGk=".into()
            }]
        );
    }

    #[test]
    fn osc777_started_parsed() {
        assert_eq!(
            scan(b"\x1b]777;mast-started\x07"),
            vec![OscEvent::Osc777Started]
        );
        // ST 종결·청크 분할도 같은 계약 (전송·질의와 같은 스캐너 경로).
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b]777;mast-st"), vec![]);
        assert_eq!(s.feed(b"arted\x1b\\"), vec![OscEvent::Osc777Started]);
    }

    #[test]
    fn osc777_started_ignores_trailing_fields() {
        // 표식은 도착 사실만으로 끝나므로 뒤에 붙은 것이 해석을 바꾸지 않는다 —
        // 나중에 필드를 덧붙여도 구버전이 표식을 놓치지 않게 하는 여지다.
        assert_eq!(
            scan(b"\x1b]777;mast-started;7\x07"),
            vec![OscEvent::Osc777Started]
        );
    }

    /// 테스트 전용 표준 base64 인코더 — 코어에는 인코더가 없다 (디코드만 소비한다).
    fn b64(input: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b0 = chunk[0];
            let b1 = *chunk.get(1).unwrap_or(&0);
            let b2 = *chunk.get(2).unwrap_or(&0);
            out.push(ALPHABET[(b0 >> 2) as usize] as char);
            out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[(b2 & 0x3f) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    fn agent_events(json: &str) -> Vec<OscEvent> {
        scan(format!("\x1b]777;mast-agent;{}\x07", b64(json.as_bytes())).as_bytes())
    }

    fn agent_json(value: serde_json::Value) -> Vec<OscEvent> {
        agent_events(&value.to_string())
    }

    fn valid_agent() -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "agent": "claude",
            "session": "abc-123",
            "transcript": "/home/u/.claude/projects/x/abc.jsonl",
        })
    }

    #[test]
    fn osc777_agent_parsed() {
        assert_eq!(
            agent_json(valid_agent()),
            vec![OscEvent::Osc777Agent(AgentSession {
                agent: AgentKind::Claude,
                session_id: "abc-123".into(),
                transcript_path: "/home/u/.claude/projects/x/abc.jsonl".into(),
            })]
        );

        let mut codex = valid_agent();
        codex["agent"] = serde_json::json!("codex");
        codex["session"] = serde_json::json!("t:0.1");
        codex["transcript"] = serde_json::json!("/home/u/.codex/sessions/x.jsonl");
        assert_eq!(
            agent_json(codex),
            vec![OscEvent::Osc777Agent(AgentSession {
                agent: AgentKind::Codex,
                session_id: "t:0.1".into(),
                transcript_path: "/home/u/.codex/sessions/x.jsonl".into(),
            })]
        );
    }

    #[test]
    fn osc777_agent_st_terminated_and_split() {
        let payload = b64(valid_agent().to_string().as_bytes());
        let seq = format!("\x1b]777;mast-agent;{payload}\x1b\\");
        let bytes = seq.as_bytes();
        let split = bytes.len() / 2;
        let mut s = OscScanner::new();
        assert_eq!(s.feed(&bytes[..split]), vec![]);
        assert_eq!(s.feed(&bytes[split..]).len(), 1, "ST 종결·청크 분할");
    }

    #[test]
    fn osc777_agent_accepts_boundary_lengths_and_extra_keys() {
        let mut value = valid_agent();
        value["session"] = serde_json::json!("a".repeat(MAX_AGENT_SESSION_CHARS));
        value["transcript"] =
            serde_json::json!(format!("/{}", "a".repeat(MAX_AGENT_TRANSCRIPT_BYTES - 1)));
        // 모르는 추가 키는 무시한다 (전방 호환).
        value["future"] = serde_json::json!({"nested": [1, 2, 3], "unknown": null});
        let events = agent_json(value);
        assert_eq!(events.len(), 1);
        match &events[0] {
            OscEvent::Osc777Agent(session) => {
                assert_eq!(session.session_id.len(), MAX_AGENT_SESSION_CHARS);
                assert_eq!(session.transcript_path.len(), MAX_AGENT_TRANSCRIPT_BYTES);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn osc777_agent_rejects_each_malformed_field() {
        // 세 번째 필드 없음 / 잘못된 base64.
        assert_eq!(scan(b"\x1b]777;mast-agent\x07"), vec![]);
        assert_eq!(scan(b"\x1b]777;mast-agent;!!!\x07"), vec![]);

        // JSON 아님·객체 아님.
        assert_eq!(agent_events("not json"), vec![]);
        assert_eq!(agent_events("[]"), vec![]);
        assert_eq!(agent_events("\"claude\""), vec![]);

        // 필드 누락.
        for key in ["v", "agent", "session", "transcript"] {
            let mut value = valid_agent();
            value.as_object_mut().unwrap().remove(key);
            assert_eq!(agent_json(value), vec![], "{key} 누락은 거부");
        }

        // v 는 정수 1 만.
        for v in [
            serde_json::json!(2),
            serde_json::json!("1"),
            serde_json::json!(1.5),
        ] {
            let mut value = valid_agent();
            value["v"] = v.clone();
            assert_eq!(agent_json(value), vec![], "v={v}");
        }

        // 모르는 agent.
        let mut value = valid_agent();
        value["agent"] = serde_json::json!("gemini");
        assert_eq!(agent_json(value), vec![]);

        // session 빈 값·129자·금지 문자(`/`·공백·비ASCII).
        for session in [
            String::new(),
            "a".repeat(MAX_AGENT_SESSION_CHARS + 1),
            "abc/def".to_owned(),
            "abc def".to_owned(),
            "세션".to_owned(),
        ] {
            let mut value = valid_agent();
            value["session"] = serde_json::json!(session);
            assert_eq!(agent_json(value), vec![], "session={session:?}");
        }

        // transcript 비절대·`..` 컴포넌트·4096 bytes 초과.
        for transcript in [
            "relative/x.jsonl".to_owned(),
            "/home/u/../x.jsonl".to_owned(),
            format!("/{}", "a".repeat(MAX_AGENT_TRANSCRIPT_BYTES)),
        ] {
            let mut value = valid_agent();
            value["transcript"] = serde_json::json!(transcript);
            assert_eq!(agent_json(value), vec![], "transcript={transcript:?}");
        }

        // 디코드 결과 8 KiB 초과 — JSON 자체는 멀쩡하고 상한만 넘는다.
        let mut value = valid_agent();
        value["pad"] = serde_json::json!("a".repeat(MAX_AGENT_PAYLOAD_BYTES));
        assert_eq!(agent_json(value), vec![]);
    }

    #[test]
    fn osc777_query_without_reply_field_ignored() {
        // 회신 경로 필드가 없으면 이벤트가 되지 않는다 (답을 보낼 곳이 없다).
        assert_eq!(scan(b"\x1b]777;mast-query;list-tabs\x07"), vec![]);
        assert_eq!(scan(b"\x1b]777;mast-query\x07"), vec![]);
    }

    #[test]
    fn osc777_query_keeps_unknown_kind_verbatim() {
        // 질의 종류의 해석은 상위 계층 몫이다 — 파서는 필드만 나눈다.
        assert_eq!(
            scan(b"\x1b]777;mast-query;whatever;aGk=\x07"),
            vec![OscEvent::Osc777Query {
                kind: "whatever".into(),
                reply_b64: "aGk=".into()
            }]
        );
    }

    #[test]
    fn osc777_notify_contract_unchanged_by_send_kind() {
        // mast-send 추가가 기존 notify 계약을 건드리지 않는지 (회귀 잠금).
        assert_eq!(
            scan(b"\x1b]777;notify;mast:idle;done\x07"),
            vec![OscEvent::Osc777Notify {
                title: "mast:idle".into(),
                body: "done".into()
            }]
        );
        // 비슷하지만 다른 kind 는 여전히 무시된다.
        assert_eq!(scan(b"\x1b]777;mast-sendx;t;aGk=\x07"), vec![]);
        assert_eq!(scan(b"\x1b]777;send;t;aGk=\x07"), vec![]);
        assert_eq!(scan(b"\x1b]777;mast-queryx;t;aGk=\x07"), vec![]);
        assert_eq!(scan(b"\x1b]777;query;t;aGk=\x07"), vec![]);
    }

    #[test]
    fn osc10_and_osc11_queries_detected() {
        // 전경(10)·배경(11) 질의 — BEL·ST 종결 양쪽.
        assert_eq!(
            scan(b"\x1b]10;?\x07"),
            vec![OscEvent::OscColorQuery { code: 10 }]
        );
        assert_eq!(
            scan(b"\x1b]11;?\x1b\\"),
            vec![OscEvent::OscColorQuery { code: 11 }]
        );
    }

    #[test]
    fn osc_color_query_split_across_feeds() {
        // 청크 경계에서 나뉘어도 같은 계약 (다른 OSC 와 같은 스캐너 경로).
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b]11"), vec![]);
        assert_eq!(
            s.feed(b";?\x07"),
            vec![OscEvent::OscColorQuery { code: 11 }]
        );
    }

    #[test]
    fn osc_color_set_not_detected() {
        // set 형태는 감지 대상이 아니다 — 그대로 xterm 까지 passthrough 된다
        // (host.rs THEME_SYNC 가 내보내는 값도 이 경로다).
        assert_eq!(scan(b"\x1b]10;#cccccc\x1b\\"), vec![]);
        assert_eq!(scan(b"\x1b]11;#1e1e1e\x1b\\"), vec![]);
        assert_eq!(scan(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07"), vec![]);
        // `?` 가 섞여 있어도 payload 전체가 정확히 "?" 여야 질의다.
        assert_eq!(scan(b"\x1b]11;??\x07"), vec![]);
        assert_eq!(scan(b"\x1b]11;?;10;?\x07"), vec![]);
        assert_eq!(scan(b"\x1b]11\x07"), vec![]);
    }

    #[test]
    fn osc12_query_not_detected() {
        // 커서 색(12) 등 다른 색 슬롯은 응답 대상이 아니다 — 답할 값이 없다.
        assert_eq!(scan(b"\x1b]12;?\x07"), vec![]);
        assert_eq!(scan(b"\x1b]4;1;?\x07"), vec![]);
    }

    #[test]
    fn split_across_two_feeds() {
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b]9;he"), vec![]);
        assert_eq!(
            s.feed(b"llo\x07"),
            vec![OscEvent::Osc9Notify("hello".into())]
        );
    }

    #[test]
    fn split_across_three_feeds() {
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b]77"), vec![]);
        assert_eq!(s.feed(b"7;notify;Ti"), vec![]);
        assert_eq!(
            s.feed(b"tle;Body\x07"),
            vec![OscEvent::Osc777Notify {
                title: "Title".into(),
                body: "Body".into()
            }]
        );
    }

    #[test]
    fn st_terminator_split_at_chunk_boundary() {
        // ST 의 ESC 와 `\` 가 서로 다른 청크로 나뉘는 경우.
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b]0;t\x1b"), vec![]);
        assert_eq!(s.feed(b"\\"), vec![OscEvent::Osc0Title("t".into())]);
    }

    #[test]
    fn esc_bracket_split_at_chunk_boundary() {
        // 시퀀스 도입부 `ESC ]` 가 청크 경계에서 나뉘는 경우.
        let mut s = OscScanner::new();
        assert_eq!(s.feed(b"\x1b"), vec![]);
        assert_eq!(s.feed(b"]9;n\x07"), vec![OscEvent::Osc9Notify("n".into())]);
    }

    #[test]
    fn oversized_payload_discarded() {
        let mut input = Vec::from(&b"\x1b]9;"[..]);
        input.extend(std::iter::repeat_n(b'a', 64 * 1024 + 1));
        input.push(0x07);
        let mut s = OscScanner::new();
        assert_eq!(s.feed(&input), vec![]);
        // 폐기 후에도 스캐너는 정상 동작해야 한다.
        assert_eq!(
            s.feed(b"\x1b]9;ok\x07"),
            vec![OscEvent::Osc9Notify("ok".into())]
        );
    }

    #[test]
    fn payload_at_exact_cap_kept() {
        // 정확히 4096 bytes 는 상한 이내 — 유지된다. payload 는 "9;" + 본문.
        let mut input = Vec::from(&b"\x1b]9;"[..]);
        input.extend(std::iter::repeat_n(b'a', 4094));
        input.push(0x07);
        let events = scan(&input);
        assert_eq!(events.len(), 1);
        match &events[0] {
            OscEvent::Osc9Notify(s) => assert_eq!(s.len(), 4094),
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn non_osc_escape_sequences_ignored() {
        // SGR(색상) 등 CSI 시퀀스는 이벤트를 만들지 않는다.
        assert_eq!(scan(b"\x1b[31mred\x1b[0m\x1b(B"), vec![]);
    }

    #[test]
    fn osc_between_plain_text_and_csi() {
        assert_eq!(
            scan(b"hello \x1b[1mbold\x1b[0m \x1b]0;t\x07 world"),
            vec![OscEvent::Osc0Title("t".into())]
        );
    }

    #[test]
    fn multiple_events_in_one_feed() {
        assert_eq!(
            scan(b"\x1b]0;a\x07mid\x1b]9;b\x1b\\"),
            vec![
                OscEvent::Osc0Title("a".into()),
                OscEvent::Osc9Notify("b".into())
            ]
        );
    }

    #[test]
    fn unknown_osc_code_ignored() {
        assert_eq!(scan(b"\x1b]52;c;aGVsbG8=\x07"), vec![]);
    }

    #[test]
    fn invalid_utf8_lossy_converted() {
        assert_eq!(
            scan(b"\x1b]0;t\xff\x07"),
            vec![OscEvent::Osc0Title("t\u{FFFD}".into())]
        );
    }

    #[test]
    fn osc_aborted_by_new_osc() {
        // 미종결 OSC 도중 `ESC ]` 로 새 OSC 가 시작되면 앞 시퀀스는 폐기된다.
        assert_eq!(
            scan(b"\x1b]0;abandoned\x1b]9;n\x07"),
            vec![OscEvent::Osc9Notify("n".into())]
        );
    }

    #[test]
    fn osc_aborted_by_other_escape() {
        // OSC 도중 ESC + 기타면 진행 중이던 OSC 가 버려진다 — 그 OSC 에서는
        // 아무 이벤트도 나오지 않는다. 뒤따르는 시퀀스 자체는 스캔되므로(CSI·RIS
        // 는 아래 두 테스트에서 실제로 감지된다) 여기서는 감지 대상이 아닌 SGR 을
        // 쓴다.
        assert_eq!(
            scan(b"\x1b]0;abandoned\x1b[0m\x1b]9;n\x07"),
            vec![OscEvent::Osc9Notify("n".into())]
        );
    }

    #[test]
    fn osc_aborted_by_can() {
        // CAN(0x18) 은 진행 중인 OSC 를 중단시킨다 — 이후 텍스트를 삼키지 않는다.
        assert_eq!(
            scan(b"\x1b]0;abandoned\x18plain text\x1b]9;n\x07"),
            vec![OscEvent::Osc9Notify("n".into())]
        );
    }

    #[test]
    fn osc_aborted_by_sub() {
        assert_eq!(
            scan(b"\x1b]777;notify;t;b\x1aplain\x1b]9;n\x07"),
            vec![OscEvent::Osc9Notify("n".into())]
        );
    }

    #[test]
    fn empty_payload_fields() {
        assert_eq!(
            scan(b"\x1b]0;\x07"),
            vec![OscEvent::Osc0Title(String::new())]
        );
    }

    fn dec(modes: &[u16], set: bool) -> OscEvent {
        OscEvent::DecPrivateMode {
            modes: modes.to_vec(),
            set,
        }
    }

    #[test]
    fn dec_private_mode_set_and_reset() {
        assert_eq!(scan(b"\x1b[?2004h"), vec![dec(&[2004], true)]);
        assert_eq!(scan(b"\x1b[?25l"), vec![dec(&[25], false)]);
    }

    #[test]
    fn dec_private_mode_multi_param() {
        assert_eq!(scan(b"\x1b[?1000;1006h"), vec![dec(&[1000, 1006], true)]);
        assert_eq!(
            scan(b"\x1b[?1049;1002;1006l"),
            vec![dec(&[1049, 1002, 1006], false)]
        );
    }

    #[test]
    fn sequences_split_at_every_byte_boundary() {
        // 청크 경계는 PTY read 단위라 어디서든 갈라진다 — 모든 분할점에서 같은
        // 이벤트가 나와야 한다. 상태 머신의 갈래마다(CSI 파라미터 수집, 2바이트
        // ESC 시퀀스, 중간 바이트, OSC payload) 경계 처리가 다르므로 하나씩 건다.
        let cases: &[(&[u8], OscEvent)] = &[
            (b"\x1b[?1000;1006h", dec(&[1000, 1006], true)),
            (b"\x1b[?1049;1002;1006l", dec(&[1049, 1002, 1006], false)),
            (b"\x1bc", OscEvent::TerminalReset { soft: false }),
            (b"\x1b[!p", OscEvent::TerminalReset { soft: true }),
            (b"\x1b]777;mast-started\x07", OscEvent::Osc777Started),
        ];
        for (input, expected) in cases {
            for split in 0..=input.len() {
                let mut s = OscScanner::new();
                let mut events = s.feed(&input[..split]);
                events.extend(s.feed(&input[split..]));
                assert_eq!(events, vec![expected.clone()], "{input:?} split at {split}");
            }
        }
    }

    #[test]
    fn non_private_csi_ignored() {
        // private 접두사(`?`)가 없으면 감지 대상이 아니다.
        assert_eq!(scan(b"\x1b[2J"), vec![]);
        assert_eq!(scan(b"\x1b[4h"), vec![]);
        assert_eq!(scan(b"\x1b[20l"), vec![]);
        assert_eq!(scan(b"\x1b[1;31m"), vec![]);
    }

    #[test]
    fn dec_mode_query_and_save_restore_ignored() {
        // DECRQM(`?…$p`) 은 질의라 상태가 아니고, XTSAVE/XTRESTORE(`?…s`/`?…r`)는
        // 값을 바꾸지 않는다 — 어느 쪽도 재-attach 때 다시 세울 대상이 아니다.
        assert_eq!(scan(b"\x1b[?2004$p"), vec![]);
        assert_eq!(scan(b"\x1b[?1049s"), vec![]);
        assert_eq!(scan(b"\x1b[?1049r"), vec![]);
    }

    #[test]
    fn malformed_dec_mode_params_ignored() {
        // 파라미터가 없거나(`?h`), 비숫자가 섞였거나, u16 을 넘으면 미감지.
        assert_eq!(scan(b"\x1b[?h"), vec![]);
        assert_eq!(scan(b"\x1b[?l"), vec![]);
        assert_eq!(scan(b"\x1b[?;1h"), vec![]);
        assert_eq!(scan(b"\x1b[?1;h"), vec![]);
        assert_eq!(scan(b"\x1b[?1a2h"), vec![]);
        assert_eq!(scan(b"\x1b[?65536h"), vec![]);
    }

    #[test]
    fn csi_aborted_by_can_and_scanner_recovers() {
        assert_eq!(
            scan(b"\x1b[?100\x18plain text\x1b]9;n\x07"),
            vec![OscEvent::Osc9Notify("n".into())]
        );
        assert_eq!(
            scan(b"\x1b[?100\x1aplain text\x1b[?25l"),
            vec![dec(&[25], false)]
        );
    }

    #[test]
    fn oversized_csi_params_discarded_and_scanner_recovers() {
        let mut input = Vec::from(&b"\x1b[?"[..]);
        input.extend(std::iter::repeat_n(b'1', MAX_CSI_BYTES + 1));
        input.push(b'h');
        let mut s = OscScanner::new();
        assert_eq!(s.feed(&input), vec![]);
        assert_eq!(s.feed(b"\x1b[?25l"), vec![dec(&[25], false)]);
    }

    #[test]
    fn ris_and_decstr_are_terminal_resets() {
        assert_eq!(
            scan(b"\x1bc"),
            vec![OscEvent::TerminalReset { soft: false }]
        );
        assert_eq!(
            scan(b"\x1b[!p"),
            vec![OscEvent::TerminalReset { soft: true }]
        );
        // 파라미터가 붙어도 DECSTR 이다 — 실제 emitter 가 쓰는 형태.
        assert_eq!(
            scan(b"\x1b[0!p"),
            vec![OscEvent::TerminalReset { soft: true }]
        );
        // 비슷하지만 다른 것들은 리셋이 아니다.
        assert_eq!(scan(b"\x1b[p"), vec![]);
        assert_eq!(scan(b"\x1b[!q"), vec![]);
    }

    #[test]
    fn ris_after_unterminated_osc_still_detected() {
        // 종결자 없는 OSC 뒤에 붙은 RIS — 앞 시퀀스만 폐기되고 리셋은 잡힌다.
        assert_eq!(
            scan(b"\x1b]0;title\x1bc"),
            vec![OscEvent::TerminalReset { soft: false }]
        );
    }

    #[test]
    fn osc_immediately_after_csi_in_one_chunk() {
        // 한 청크에 CSI 와 OSC 가 붙어 와도 둘 다 잡힌다 (상태가 Ground 로
        // 제대로 복귀하는지 — 셸 프롬프트 한 줄이 실제로 이 모양이다).
        assert_eq!(
            scan(b"\x1b[?2004h\x1b]777;mast-started\x07"),
            vec![dec(&[2004], true), OscEvent::Osc777Started]
        );
        assert_eq!(
            scan(b"\x1b]0;t\x07\x1b[?1049h"),
            vec![OscEvent::Osc0Title("t".into()), dec(&[1049], true)]
        );
    }

    #[test]
    fn csi_after_unterminated_osc_still_detected() {
        // 종결자 없는 OSC 뒤에 붙은 DECSET — 앞 시퀀스만 폐기되고 CSI 는 잡힌다.
        assert_eq!(
            scan(b"\x1b]0;abandoned\x1b[?2004h"),
            vec![dec(&[2004], true)]
        );
    }
}
