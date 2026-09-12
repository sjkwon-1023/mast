// 터미널 뷰 — 기존 PTY 세션에 attach 하는 xterm 1개 (12단계: 탭별 keep-alive).
//
// keep-alive 수명 (계획 D3·D7): 뷰는 탭 단위 앱 수준 레지스트리(workspace-view 의
// Map<TabId, TerminalView>)가 소유하고, 탭 전환은 dispose 가 아니라 setVisible
// (display 토글)로 처리한다 — 숨은 뷰도 채널을 유지하며 계속 ack 한다 (xterm 은
// IntersectionObserver 로 렌더만 멈추고, 재표시 시 full refresh 한다). fit 은 뷰당
// ResizeObserver 대신 pane 당 1개(pane-view 소유)가 표시 중인 뷰의 scheduleFit
// 을 부른다. attach 말미 자동 focus 는 제거됐다 — 보상 경로(부트 리컨실·생성/
// 활성화 성공 직후)는 workspace-view 의 pendingFocus 가 담당한다.
//
// attach 프로토콜 (계약은 코어 session.rs `PtySession::reattach` rustdoc):
//   1) Channel 을 **attach_terminal 호출 전에** 만들어 onmessage 큐잉을 시작한다
//      (채널 먼저·reattach 나중 — 순서를 어기면 유실 창이 생긴다).
//   2) 응답 raw body `[u64 LE end_offset][replay bytes]` 를 파싱해 replay 를
//      term.write 한다. replay 는 invoke 응답 경로라 flow 계정 대상이 아니다 —
//      ack 하지 않는다 (reattach 가 flow 를 리셋했다).
//   3) 큐잉분·이후 chunk 는 AttachGate 로 판정: offset < end_offset 폐기(dedup),
//      **폐기분 포함 전량 ack** (AckBatcher 경유 — ack 누락 시 paused 고착).
//   4) 직후 resize nudge — 항상 rows-1 → rows 2단 호출로 SIGWINCH 를 강제한다
//      (10단계 계획 0-2). 프론트는 PTY 현재 크기를 모르고, 특히 F5 리로드에서는
//      실측 == PTY 현재 크기라 동일 크기 재설정이 no-op 이 되기 때문이다.
//      이 nudge 는 재그리기만 시키는 것이 아니라 **스크롤백을 복구**하기도 한다 —
//      Codex 는 resize 마다 자기 히스토리를 통째로 다시 인쇄하므로(실측 약 96 KB·
//      1,038줄) replay 창이 잘라낸 스크롤백이 되살아난다 (ADR-0019).
//
// 스크롤 위치 복원 (ADR-0019): 워크스페이스를 떠날 때 뷰가 dispose 되는데(ADR-0004
// 메모리 모델), 스크롤 위치는 xterm 쪽 상태(viewportY 대 baseY)라 replay 바이트에
// 실리지 않는다. workspace-view 가 dispose 직전 값을 탭별로 기억했다가 다음 생성
// 때 restoreScrollOffset 으로 넘기고, 여기서 되돌린다 — replay 재생 직후 한 번,
// 그 뒤 **파싱되는 chunk 마다**, 그리고 재인쇄가 잠잠해진 시점에 한 번 더. 한 번
// 으로 끝나지 않는 이유는 위 nudge 가 유발한 재인쇄가 ESC[3J 로 스크롤백을 지웠다
// 다시 쌓기 때문이다(그래서 중간에는 기억한 자리가 아직 없다). 그 사이 사용자가
// 키(이 pane 이 포커스일 때)·휠·스크롤바 드래그로 개입하면 복원을 버린다 —
// 사용자 의도가 앱의 되돌리기보다 우선이다.
//
// 복사/붙여넣기 키 처리는 spike terminal-tile.ts 에서 그대로 가져왔다 (Windows
// Terminal 컨벤션 — 이미 Windows 검증 완료된 코드):
// - Ctrl+V, Ctrl+Shift+V, Shift+Insert: 붙여넣기 (클립보드 → term.paste 단일 경로)
// - Ctrl+C·Ctrl+Shift+C·Ctrl+Insert (선택 있을 때만): 복사. 선택 없는 Ctrl+C 는
//   그대로 SIGINT.
// - Shift+Enter: ESC CR 재작성 (Claude Code 줄바꿈 관례 — 아래 핸들러 주석).
// - Esc 는 여기서 가로채지 않는다 — 단 **send-mode(전달 대상 선택) 활성 중에만**
//   workspace-view 의 window keydown capture 가 취소용으로 선점한다 (17단계,
//   계획 v2 3장 가로채기 목록의 의도적 확장). 평시 Esc 는 그대로 PTY 로 간다.
//   (현재 send-mode 는 UI 진입점이 없어 휴면이라 이 선점은 실제로 일어나지
//   않는다 — keys.ts 가로채기 표 참조.)
//
// 글꼴은 모듈 수준 상태다 (뷰가 탭마다 새로 생기므로): settings.json 부팅값을
// applyTerminalSettings 가 심고, 런타임 줌(`Ctrl+=`/`Ctrl+-`/`Ctrl+0`)은
// adjustFontSize/resetFontSize 가 살아있는 뷰 레지스트리 전체에 건다. 줌은 **세션
// 한정**이라 settings.json 에 되쓰지 않는다 (adjustFontSize 주석 참조). 키 판정
// 자체는 keys.ts(가로채기 표가 정본) + main.ts 글루 소관이다.
//
// **줌 키는 이제 터미널 전용이 아니다** (v0.3.8): 같은 키가 뷰어 표면에도 같은
// 스텝으로 걸린다 — 이 모듈과 짝을 이루는 뷰어 쪽 경로가 viewer-font.ts 의
// adjustViewerFontSize/resetViewerFontSize 이고, 둘을 같이 부르는 자리는 main.ts
// runNavAction 한 곳이다. 두 표면은 유효 크기·기준값을 **따로** 들고 있다
// (터미널 기본 13px · 뷰어 기본 12px). 클램프 범위만 font-size.ts 로 공유한다.
//
// 세션 수명은 dispatcher(CloseTab/ClosePane/CloseWorkspace) 소유다 — dispose 는
// 뷰만 해제하고 세션을 죽이지 않는다.

import { Terminal } from "@xterm/xterm";
import type { IDisposable, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

import { AckBatcher } from "./ack-batcher";
import { AttachGate } from "./attach-gate";
import type { GateResult } from "./attach-gate";
import {
  ackOutput,
  attachTerminal,
  detachTerminal,
  openUrl,
  resizeTerminal,
  writeStdin,
} from "./backend";
import type { OutputChunk, UiSettings } from "./backend";
import { clampFontSize } from "./font-size";
import { parseAttachBody, parseFrame } from "./frame";
import type { SessionId } from "./types";

// 클램프는 뷰어 줌과 공유한다 (font-size.ts) — 여기서 다시 내보내는 이유는 줌
// 규칙이 터미널 API 의 일부로 계속 보여야 하기 때문이다 (호출자·테스트는 종전
// 그대로 이 모듈에서 가져온다).
export { clampFontSize };

/** 터미널 색 테마 — VS Code 기본 다크 터미널 팔레트 전체(16색 ANSI 포함).
 *
 *  배경만 지정하고 팔레트를 xterm 기본값에 맡기면 TUI 가 배경에 묻힌다 (실기
 *  결함: Codex TUI 의 입력창 구분선·배경이 터미널 배경과 구분되지 않았다).
 *  TUI 는 프레임·구분선·비활성 텍스트를 black/brightBlack 이나 dim 으로 그리는데,
 *  **brightBlack 이 배경(#1e1e1e)과 충분히 갈리는 것이 입력창 구분의 핵심**이다 —
 *  이 팔레트의 brightBlack(#666666)은 배경보다 확실히 밝아 구분선이 보이고,
 *  black(#000000)은 반대로 배경보다 어두워 채움면이 구분된다. 값을 임의로 고르지
 *  않고 VS Code 기본 다크를 통째로 쓰는 이유는 그 조합이 같은 배경(#1e1e1e) 위에서
 *  TUI 가독성이 이미 검증된 조합이기 때문이다 — 개별 색을 손대면 그 검증이 깨진다.
 *
 *  **3자 동기화 계약**: 이 팔레트의 foreground/background 는 백엔드 두 곳에 같은
 *  값으로 적혀 있다 — `src-tauri/src/host.rs` 의 `THEME_SYNC`(ConPTY 색 테이블에
 *  내보내는 OSC 10/11 set)와 `src-tauri/src/sink.rs` 의 `COLOR_REPLY_FOREGROUND`/
 *  `COLOR_REPLY_BACKGROUND`(OSC 10/11 **질의**에 앱이 직접 답하는 응답기). 여기가
 *  값의 정본이고, 이 둘을 바꾸면 그 셋을 같이 바꾼다 (갈라지면 TUI 가 실제 배경과
 *  다른 색을 기준으로 자기 색을 골라 입력창이 배경에 묻힌다). */
const TERMINAL_THEME: ITheme = {
  foreground: "#cccccc",
  background: "#1e1e1e",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

/** 폰트 기본값 — 설정(settings.json)이 없을 때 쓰는 값이자, 종전에 Terminal
 *  생성 옵션에 하드코딩돼 있던 그 값이다 (승격만 했고 값은 그대로).
 *  Consolas/Cascadia Mono 는 Windows 기본 탑재 등폭 폰트라 설치 전제가 없다. */
const DEFAULT_FONT_FAMILY = "Consolas, 'Cascadia Mono', monospace";
const DEFAULT_FONT_SIZE = 13;

/** 현재 적용 중인 폰트 — 모듈 수준 상태다. 뷰가 탭마다 새로 생기므로 인스턴스가
 *  아니라 모듈이 들고 있어야 이후 만들어지는 모든 뷰에 같은 값이 적용된다.
 *  fontSize 는 줌(Ctrl+= / Ctrl+-)이 움직이는 **유효 크기**이고, baseFontSize 는
 *  줌 리셋(Ctrl+0)이 돌아갈 부팅값(settings.json 또는 기본값)이다. */
let fontFamily = DEFAULT_FONT_FAMILY;
let fontSize = DEFAULT_FONT_SIZE;
let baseFontSize = DEFAULT_FONT_SIZE;

/** 줌을 받아야 하는 터미널 표면 — TerminalView 와, 같은 글꼴로 여는 기록 뷰
 *  (record-view.ts)가 구현한다. 구조 타입인 이유는 기록 뷰가 뷰어 수명을 타는
 *  별도 클래스라서다 (ADR-0018) — 같은 키가 두 표면을 같은 스텝으로 움직여야
 *  하므로 레지스트리는 하나여야 한다. */
export interface TerminalFontTarget {
  setFontSize(size: number): void;
}

/** 살아있는 터미널 표면 레지스트리 — 줌은 "지금 열려 있는 모든 터미널"에
 *  동시에 걸리므로 인스턴스 목록이 필요하다. 등록·해제는 생성자와 dispose 가
 *  짝으로 맡는다 (dispose 된 뷰가 남아 이미 죽은 xterm 을 건드리지 않게). */
const liveViews = new Set<TerminalFontTarget>();

/** 뷰 생성자가 자신을 등록한다 — 해제는 dispose 의 unregisterTerminalFontTarget. */
export function registerTerminalFontTarget(view: TerminalFontTarget): void {
  liveViews.add(view);
}

export function unregisterTerminalFontTarget(view: TerminalFontTarget): void {
  liveViews.delete(view);
}

/** 지금 터미널 표면을 여는 xterm 옵션 — 기록 뷰가 같은 글꼴·테마로 열기 위해
 *  읽는다. 모듈 상태를 복사해 돌려주므로 호출자가 바꿔도 여기 값은 불변이다
 *  (줌의 정본은 adjustFontSize 하나다). */
export function terminalViewOptions(): {
  fontSize: number;
  fontFamily: string;
  theme: ITheme;
} {
  return { fontSize, fontFamily, theme: { ...TERMINAL_THEME } };
}

/** 줌 ±1px (`Ctrl+=` / `Ctrl+-`) — 현재 유효 크기에 delta 를 더해 클램프하고,
 *  살아있는 모든 뷰에 적용한다. 이후 새로 열리는 탭도 모듈 상태를 읽으므로 같은
 *  크기로 열린다 (한 창 안에서 탭마다 글꼴이 다른 상태를 만들지 않는다).
 *
 *  **줌은 세션 한정이다 — settings.json 에 되쓰지 않는다** (백로그 결정
 *  2026-08-12). 줌은 "지금 이 화면을 잠깐 키우는" 조작이고 영구 설정은 파일이
 *  담당한다: 되쓰면 임시 확대가 다음 부팅의 기본값이 되고, 손으로 쓴 설정 파일을
 *  앱이 말없이 고치게 된다. 영구 변경은 settings.json 을 직접 고치는 경로다.
 *
 *  **여기는 터미널 표면만 움직인다.** 같은 키가 뷰어도 같은 스텝으로 움직이지만
 *  그건 호출자(main.ts runNavAction)가 viewer-font 의 짝 함수를 같이 부르기
 *  때문이다 — 두 표면은 기준값이 달라(13px 대 12px) 유효 크기를 따로 들고,
 *  경계(6·72)에도 각자 걸린다. */
export function adjustFontSize(delta: number): void {
  applyFontSize(clampFontSize(fontSize + delta));
}

/** 줌 리셋 (`Ctrl+0`) — settings.json 부팅값(설정이 없으면 기본 13px)으로 되돌린다.
 *  "0 = 원래대로"의 원래는 앱 기본값이 아니라 **사용자가 설정한 값**이다.
 *  뷰어 쪽 리셋은 viewer-font 의 resetViewerFontSize 가 짝으로 맡는다. */
export function resetFontSize(): void {
  applyFontSize(baseFontSize);
}

/** 모듈 상태 갱신 + 전 인스턴스 반영. 값이 그대로면(경계에 걸렸거나 이미 그 크기)
 *  아무 것도 하지 않는다 — 무변경 refit 은 PTY resize 왕복만 낭비한다. */
function applyFontSize(size: number): void {
  if (size === fontSize) return;
  fontSize = size;
  for (const view of liveViews) view.setFontSize(size);
}

/** settings.json 의 폰트 설정을 적용한다 (main.ts 부트가 **뷰 생성 전에** 1회
 *  호출). null 필드는 미설정이라 기본값을 유지한다.
 *
 *  값 검증은 백엔드(`get_ui_settings`)가 이미 했다 — 여기서 다시 판정하면 두
 *  곳의 규칙이 갈라질 수 있어 받은 값을 그대로 반영한다.
 *
 *  **순서 안전**: 터미널 뷰는 첫 스냅샷 렌더(store.init → render → workspace-view)
 *  부터 생기고, 이 호출은 그 앞(store.init 앞)이라 이미 만들어진 뷰를 뒤늦게
 *  고치는 경로가 필요 없다. 반대로 순서가 뒤집히면 첫 스냅샷의 탭들만 기본 폰트로
 *  남는 비일관이 생긴다. */
export function applyTerminalSettings(settings: UiSettings): void {
  if (settings.fontFamily !== null) fontFamily = settings.fontFamily;
  if (settings.fontSize !== null) {
    fontSize = settings.fontSize;
    // 줌 리셋의 복귀 지점 — 이 호출이 부팅 1회이므로 여기가 "기본값"의 정의다.
    baseFontSize = settings.fontSize;
  }
}

/** 클립보드에 이미지 항목이 있는지 묻는다 — Ctrl+V 를 PTY 로 넘길지의 판정
 *  (pasteFromClipboard 주석 참조). 권한 거부·미지원으로 물어보지 못하면 false 다:
 *  모르는 상태에서 키를 넘기면 셸이 quoted-insert 로 들어가므로, 모를 때는 넘기지
 *  않는 쪽이 안전하다. */
async function clipboardHasImage(): Promise<boolean> {
  try {
    const items = await navigator.clipboard.read();
    return items.some((item) => item.types.some((type) => type.startsWith("image/")));
  } catch (err) {
    console.error("clipboard inspect failed", err);
    return false;
  }
}

/** 터미널에서 클릭된 링크를 우리가 열지 말지의 판정 — 순수 함수라 테스트가 계약을
 *  잡는다 (ADR-0012).
 *
 *  두 가지를 본다.
 *
 *  1. **스킴**: `http`/`https` 만 연다. 클릭 한 번이 `ShellExecute` 로 가는 경로라
 *     `file:`·`ms-settings:`·임의 프로토콜 핸들러까지 열어 주면, 터미널에 텍스트를 찍을
 *     수 있는 아무나(에이전트가 출력한 로그, `cat` 한 파일)가 그 표면을 겨눌 수 있다.
 *  2. **마우스 모드**: TUI 가 마우스 리포팅을 켜 두었으면 클릭은 **그 앱의 것**이다.
 *     vim·tmux·에이전트 TUI 안에서 클릭이 브라우저를 여는 것은 명백한 오작동이라,
 *     추적 모드가 꺼져 있을 때만 우리가 가로챈다. */
export function shouldOpenLink(uri: string, mouseTrackingMode: string): boolean {
  if (mouseTrackingMode !== "none") return false;
  try {
    const scheme = new URL(uri).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    // URL 로 파싱되지 않으면 우리가 다룰 대상이 아니다.
    return false;
  }
}

/** 선택 복사 키인지 — `Ctrl+C` · `Ctrl+Shift+C` · `Ctrl+Insert` 이고 선택이 있을
 *  때만 참이다 (선택 없는 `Ctrl+C` 는 SIGINT 로 통과해야 하므로 여기서 거른다).
 *
 *  뷰 밖에 있는 이유: 기록 뷰(record-view.ts)가 **같은** 판정을 써야 한다. xterm 은
 *  `disableStdin` 여부와 무관하게 `Ctrl+C` 의 keydown 을 스스로 cancel(preventDefault
 *  + stopPropagation) 하므로, 앱이 가로채지 않는 터미널 표면에서는 브라우저의 copy
 *  이벤트조차 발생하지 않아 복사가 조용히 죽는다. 규칙이 표면마다 갈리면 keys.ts
 *  상단의 정본 표가 거짓이 되므로 판정은 한 군데다. */
export function isCopySelectionKey(ev: KeyboardEvent, hasSelection: boolean): boolean {
  if (!ev.ctrlKey || ev.altKey || !hasSelection) return false;
  if (ev.key === "Insert") return !ev.shiftKey;
  return ev.key.toLowerCase() === "c";
}

/** 선택 영역을 클립보드로 복사하고 선택을 해제한다 — 해제 덕에 곧바로 한 번 더
 *  누르는 Ctrl+C 는 SIGINT 로 나간다 (Windows Terminal 과 같은 동작). */
export async function copyTerminalSelection(term: Terminal): Promise<void> {
  const text = term.getSelection();
  if (text.length === 0) return;
  try {
    await navigator.clipboard.writeText(text);
    term.clearSelection();
  } catch (err) {
    console.error("clipboard write failed", err);
  }
}

// 스크롤 위치 복원의 순수 판정 (ADR-0019) — 좌표는 **하단으로부터의 줄 수**다.
// 절대 줄 번호를 쓰지 않는 이유는 attach 말미의 nudge 가 유발하는 재인쇄가
// 스크롤백을 통째로 갈아치우기 때문이다: 줄 번호는 그때 의미를 잃지만 "아래에서
// 몇 줄 위"는 재인쇄된 히스토리에서도 같은 자리를 가리킨다.

/** dispose 직전에 기억해 둘 스크롤 위치 — 기억할 것이 없으면 null.
 *
 *  **아직 복원 중이면(pending 非null) 버퍼가 아니라 그 값이 답이다**: replay·
 *  재인쇄가 끝나기 전의 버퍼는 사용자가 보던 자리를 아직 담고 있지 않아, 그대로
 *  읽으면 돌아오자마자 다시 떠난 탭이 기억을 잃는다 (peer review 2026-09-12).
 *
 *  **대체 버퍼는 기억하지 않는다**: 그 화면의 스크롤 오프셋은 앱 상태라(Codex 의
 *  Ctrl+T 전사 오버레이는 PageUp 을 자기가 처리한다) 터미널이 되돌릴 대상이
 *  아니고, 실측상 replay 가 그 화면을 그대로 실어 나른다. 맨 아래(offset 0)도
 *  기억하지 않는다 — 재-attach 의 기본 위치가 이미 맨 아래다. */
export function scrollOffsetToRemember(
  pending: number | null,
  bufferType: "normal" | "alternate",
  baseY: number,
  viewportY: number,
): number | null {
  if (pending !== null) return pending;
  if (bufferType !== "normal") return null;
  const offset = baseY - viewportY;
  return offset > 0 ? offset : null;
}

/** 기억해 둔 하단 기준 오프셋 → 지금 버퍼에서 scrollToLine 에 넘길 줄 번호.
 *  스크롤백이 그때보다 짧아 그 자리가 아직/영영 없으면 **거절한다**(null).
 *
 *  0 으로 접으면 안 된다: scrollToLine 은 xterm 의 isUserScrolling 을 걸어 뷰가
 *  이후 출력을 따라가지 않게 만들고, 그 상태로 전사 맨 위에 붙으면 pane 이 그대로
 *  얼어붙는다 (실측: 이후 2,000줄이 들어와도 viewportY 는 0). 해제 책임은 호출자
 *  몫이다 — releaseScrollLatch 주석 참조. baseY === offset 은 진짜 맨 위라
 *  유효한 0 이다. */
export function restoreTargetLine(baseY: number, offset: number): number | null {
  if (offset > baseY) return null;
  return baseY - offset;
}

/** 마지막 chunk 후 이만큼 조용하면 재인쇄가 끝난 것으로 본다. */
export const SETTLE_QUIET_MS = 250;
/** nudge 후 이 시간이 지나면 출력이 계속되더라도 그 자리에서 복원한다. */
export const SETTLE_CAP_MS = 2_000;

/** OutputSettle.poll 의 답 — 호출자는 wait 면 nextCheckAt 에 다시 묻고,
 *  restore/abandon 이면 타이머를 걷는다. */
export type SettlePoll =
  | { kind: "wait"; nextCheckAt: number }
  | { kind: "restore" }
  | { kind: "abandon" };

/** nudge 뒤 출력이 잠잠해지는 시점의 상태기계 — 시간은 호출자가 넣는다(순수).
 *
 *  타이머를 스스로 들지 않는 이유는 이 판정이 계약이기 때문이다: "마지막 chunk 후
 *  250 ms, 단 nudge 후 2,000 ms 를 넘기지 않는다"와 "nudge 뒤 chunk 가 하나도
 *  없었으면 복원할 것이 없다"(replay 직후의 1차 복원 결과가 그대로 남아 있다)를
 *  시계 없이 테스트로 잠근다. */
export class OutputSettle {
  private startedAt: number | null = null;
  private lastChunkAt: number | null = null;
  private finished = false;

  /** nudge 완료 시점 — 여기서부터 상한 창이 돈다. */
  start(now: number): void {
    this.startedAt = now;
  }

  /** term.write 완료 1건. start 전과 종료 후는 세지 않는다 — 전자는 replay·
   *  dedup 구간이라 재인쇄가 아니고, 후자는 이미 판정이 끝났다. */
  noteChunk(now: number): void {
    if (this.finished || this.startedAt === null) return;
    this.lastChunkAt = now;
  }

  /** 사용자 개입·dispose 로 복원을 버린다 — 이후 poll 은 abandon 뿐이다. */
  cancel(): void {
    this.finished = true;
  }

  poll(now: number): SettlePoll {
    if (this.finished || this.startedAt === null) return { kind: "abandon" };
    const cap = this.startedAt + SETTLE_CAP_MS;
    const due =
      this.lastChunkAt === null ? cap : Math.min(this.lastChunkAt + SETTLE_QUIET_MS, cap);
    if (now < due) return { kind: "wait", nextCheckAt: due };
    this.finished = true;
    return this.lastChunkAt === null ? { kind: "abandon" } : { kind: "restore" };
  }
}

/** 복원을 취소시키는 사용자 개입 — 키(스크롤 키 포함)·휠·스크롤바 드래그.
 *  xterm 의 onData 는 쓰지 않는다: nudge 가 유발한 라이브 질의에 xterm 이 스스로
 *  내는 DA/CPR 응답도 같은 경로로 나와, 사용자와 터미널을 구분할 수 없다. */
const RESTORE_CANCEL_EVENTS = ["keydown", "wheel", "mousedown"] as const;

export class TerminalView {
  readonly root: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly gate = new AttachGate();
  private readonly batcher: AckBatcher;
  private onDataSub: IDisposable | null = null;
  private onResizeSub: IDisposable | null = null;
  private disposed = false;
  private fitScheduled = false;
  private visible = true;
  private opened = false;
  /** attach(term.open) 전에 focus() 가 요청된 경우의 보류 플래그 —
   *  textarea 가 아직 없어 term.focus() 가 조용히 무시되기 때문이다. */
  private focusPending = false;
  /** replay 재생 완료 전의 onData 억제 플래그 — 낡은 단말 질의에 대한 xterm
   *  자동 응답이 PTY 로 새는 것을 막는다 (attach() 의 onData 배선 주석 참조). */
  private replayDone = false;
  /** 세션별 stdin write 직렬화 큐 (17단계 리뷰 finding) — write_stdin 은 async
   *  커맨드라 invoke 마다 별도 blocking task 로 돌아 back-to-back 쓰기(paste
   *  텍스트 + submit CR)가 역전될 수 있다. 모든 stdin write 를 이 체인으로
   *  직렬화해 발행 순서 = 도착 순서를 보장한다 (타이핑은 간격이 있어 체감 지연
   *  없음 — 왕복 1회가 겹치지 않게 될 뿐이다). */
  private writeQueue: Promise<void> = Promise.resolve();
  /** 이번 attach 에서 되돌릴 스크롤 위치(하단 기준 줄 수) — 복원할 것이 없거나
   *  이미 끝났으면 null 이고, 그동안은 타이머·취소 리스너도 존재하지 않는다. */
  private restoreOffset: number | null;
  private readonly settle = new OutputSettle();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelListeners = false;
  /** scrollToLine 으로 xterm 의 isUserScrolling 래치를 걸었을 가능성 — 그 래치는
   *  우리가 건 것이므로 우리가 푼다 (releaseScrollLatch). */
  private latchedByRestore = false;
  /** baseY 0 에서 해제가 무효로 끝난 상태 — 다음 chunk 에서 다시 시도한다. */
  private releaseLatchOnNextChunk = false;

  /** stdin write 직렬화 진입점 — onData·submit 공용. */
  private enqueueWrite(data: string): void {
    this.writeQueue = this.writeQueue
      .then(() => writeStdin(this.session, data))
      .catch((err) => console.error("write_stdin failed", err));
  }

  constructor(
    parent: HTMLElement,
    /** 이 뷰가 붙은 PTY 세션. 읽기 전용으로 열어 둔 이유는 재스폰 판정 때문이다 —
     *  같은 탭이 새 세션을 받으면(Retry) 뷰를 갈아 끼워야 하고, 그 비교를 레지스트리가
     *  해야 한다 (`workspace-view.ts` 의 ensureView). */
    readonly session: SessionId,
    /** 전환 계측 훅 (14단계) — replay write 완료 + rAF 1회 뒤 replay 바이트 수로
     *  1회 호출한다 (페인트 근사 완료점). 계측 중이 아닌 attach 에는 undefined —
     *  그 경우 콜백·rAF 를 아예 걸지 않아 오버헤드가 없다. */
    private readonly onTraceReplayDone?: (bytes: number) => void,
    /** 이 탭이 워크스페이스를 떠나기 직전의 스크롤 위치(하단 기준 줄 수) —
     *  workspace-view 의 기억에서 1회성으로 꺼내 온다 (ADR-0019). 평시 attach
     *  (신규 탭·F5·최초 표시)에는 undefined 라 복원 기계가 아예 돌지 않는다. */
    restoreScrollOffset?: number,
  ) {
    this.restoreOffset = restoreScrollOffset ?? null;
    this.root = document.createElement("div");
    this.root.className = "term-host";
    parent.appendChild(this.root);

    this.term = new Terminal({
      scrollback: 5000,
      // 폰트는 모듈 상태 — settings.json 이 있으면 부트가 먼저 반영해 둔다
      // (applyTerminalSettings 주석의 순서 계약).
      fontSize,
      fontFamily,
      theme: TERMINAL_THEME,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    // 링크 클릭 → Windows 기본 브라우저 (ADR-0012). 애드온은 감지·밑줄·wrap 된 줄
    // 이어붙이기만 맡고, 열지 말지와 어디로 보낼지는 우리가 정한다.
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (!shouldOpenLink(uri, this.term.modes.mouseTrackingMode)) return;
        void openUrl(uri).catch((err: unknown) => {
          console.error("open_url failed", err);
        });
      }),
    );

    this.batcher = new AckBatcher((n) => {
      this.sendAck(n);
    });
    // 줌 대상 등록 — 해제는 dispose 가 짝으로 맡는다.
    registerTerminalFontTarget(this);
  }

  /** 글꼴 크기 적용 (줌 경로 전용 — 모듈의 adjustFontSize/resetFontSize 가 부른다).
   *  크기가 바뀌면 셀 치수가 바뀌므로 곧바로 refit 해 cols/rows 를 다시 잡는다
   *  (기존 fit 경로 재사용 — scheduleFit 의 rAF 코얼레싱을 그대로 탄다. 그 결과
   *  term.onResize → resizeTerminal 로 PTY 에도 새 크기가 나간다).
   *  숨은 뷰의 fit 은 크기 0 가드로 스킵되지만, 다시 보일 때 setVisible 이
   *  scheduleFit 을 걸어 따라잡는다 — 옵션 값은 지금 심어 두므로 유실은 없다. */
  setFontSize(size: number): void {
    if (this.disposed) return;
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  /** keep-alive 가시성 토글 — display 만 바꾼다 (채널·ack 은 계속 돈다).
   *  숨김→표시 전환 시에만 scheduleFit: 숨어 있는 동안 fit 이 크기 0 가드로
   *  스킵돼 stale 해진 dims 를 여기서 따라잡는다. */
  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.root.style.display = v ? "" : "none";
    if (v) this.scheduleFit();
  }

  /** fit 요청 — rAF 로 프레임당 1회로 코얼레싱한다. 호출자는 pane-view 의
   *  ResizeObserver(pane 당 1개 — 계획 D7)와 setVisible 전환이다. */
  scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    requestAnimationFrame(() => {
      this.fitScheduled = false;
      if (!this.disposed) this.fit();
    });
  }

  /** 명시적 focus (D7 보상 경로 전용 — attach 자동 focus 는 없다).
   *  term.open 전이면 보류했다가 attach 가 open 직후 적용한다. */
  focus(): void {
    if (!this.opened) {
      this.focusPending = true;
      return;
    }
    this.term.focus();
  }

  /** 현재 선택 텍스트 — 없으면 빈 문자열 (17단계 전달 소스 캡처).
   *  무선택 에러 판정은 호출측(pane-view) 몫이다.
   *
   *  이 메서드와 아래 4개는 pane 간 텍스트 전달(send-mode)의 터미널 측 표면이다.
   *  **send-mode 경로는 현재 휴면 상태다** — 헤더의 ⤷/⤷⏎ 버튼을 뺀 뒤로 arm
   *  진입점이 UI 에 없어 아무도 이 경로를 부르지 않는다 (`paste` 만은 Ctrl+V
   *  클립보드 경로가 함께 쓴다). 차기 agent-facing 채널이 여기에 재배선될
   *  예정이라 구현을 그대로 둔다 (pane-view 의 armSend 주석 참조). */
  getSelection(): string {
    return this.term.getSelection();
  }

  /** 붙여넣기 수신 경로 — 패널 간 텍스트 전달(17단계 D1 — 계획 v2 8장 sendText)과
   *  Ctrl+V 클립보드 붙여넣기가 함께 지난다.
   *  반드시 xterm 의 term.paste 를 경유한다: bracketed paste 모드 추적을 xterm
   *  이 담당하므로 `ESC[200~` 를 raw 로 PTY 에 쓰지 않는다 (수신 앱이 paste
   *  mode 를 안 켰으면 시퀀스가 입력으로 그대로 들어가는 사고 방지). 결과
   *  바이트는 기존 onData → write_stdin 으로 흐른다.
   *
   *  onData 는 replayDone 게이트를 지나므로, 게이트가 아직 닫혀 있으면(재-attach
   *  replay 재생 중) 이 전달은 실제로 유실된다. 전달 대상은 표시 중(attach 완료)
   *  뷰뿐이라 실질적으로는 극초기 경합 창에서만 가능하지만, 조용한 유실은 금지 —
   *  발생하면 로그로 드러낸다. */
  paste(text: string): void {
    if (!this.replayDone) {
      console.warn("[mast] paste before replay done — text dropped by onData gate", {
        session: this.session,
        length: text.length,
      });
    }
    this.term.paste(text);
  }

  /** 전달 후 실행의 submit 절반 (계획 v2 8장 sendTextAndSubmit) — CR 1회를
   *  stdin 직렬화 큐로 보낸다. paste 텍스트(onData 경유 — 같은 큐)보다 뒤에
   *  발행되므로 순서 역전이 없다 (리뷰 finding). "전달"만으로는 절대 실행되지
   *  않는다 (실수 실행 방지). */
  submit(): void {
    this.enqueueWrite("\r");
  }

  /** 전달 수신 가능 여부 (17단계 리뷰 finding) — replay 게이트가 닫혀 있으면
   *  paste 가 onData 에서 유실되는데 submit CR 만 통과하는 비대칭이 생긴다.
   *  resolveSend 가 전달 전에 이걸로 판정해 둘 다 스킵 + 에러 표면화한다. */
  canAcceptSend(): boolean {
    return this.opened && !this.disposed && this.replayDone;
  }

  /** 대상 앱의 bracketed paste 모드 (xterm 이 추적) — 여러 줄 전달의 안전 판정.
   *  모드가 꺼진 대상(예: cmd)에 여러 줄을 paste 하면 중간 라인들이 그대로
   *  실행된다 (리뷰 finding — paste 경로가 막는 것은 stray ESC[200~ 이지 라인
   *  실행이 아니다). */
  bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /** dispose 직전 workspace-view 가 읽어 가는 스크롤 위치 (ADR-0019) — 판정은
   *  모듈의 scrollOffsetToRemember 가 한다. 복원이 아직 진행 중이면 버퍼가 아니라
   *  그 pending 값이 답이다 (돌아오자마자 다시 떠나는 경로에서 기억이 증발하던
   *  결함). 이미 해제됐거나 term.open 전이면 버퍼가 없으니 pending 뿐이다. */
  rememberedScrollOffset(): number | null {
    if (this.disposed) return null;
    if (!this.opened) return this.restoreOffset;
    const buffer = this.term.buffer.active;
    return scrollOffsetToRemember(
      this.restoreOffset,
      buffer.type,
      buffer.baseY,
      buffer.viewportY,
    );
  }

  /** attach 수행 — 생성 직후 정확히 1회 호출한다. 실패는 그대로 reject 로
   *  올린다 (호출자가 뷰를 정리하고 에러를 노출한다 — 가리지 않는다). */
  async attach(): Promise<void> {
    this.term.open(this.root);
    this.opened = true;
    // 복원 대기가 있으면 취소 리스너부터 건다 — attach 전 구간에서 사용자 개입이
    // 이기게 (설치·해제는 이 한 쌍이 전부다).
    this.installRestoreCancel();
    // 초기 fit — 여기서 잡힌 실측 cols/rows 를 아래 resize nudge 에 쓴다.
    this.fit();
    this.installCopyPasteKeys();

    // 1) 채널 먼저 — 응답 도착 전에 흘러든 chunk 는 gate 가 큐잉한다.
    const channel = new Channel<OutputChunk>();
    channel.onmessage = (chunk): void => {
      this.onChunk(chunk);
    };

    // 입력 배선은 replay write 전에 건다 — 단 **replay 재생 완료 전의 onData 는
    // PTY 로 보내지 않는다** (체크포인트 1 버그 2). replay 에는 ConPTY 가 동기화용
    // 으로 넣는 단말 질의(ESC[6n 등)가 보존돼 있고, xterm 은 파싱하며 CPR
    // (`ESC[..R`) 같은 자동 응답을 onData 로 낸다 — 낡은 질의에 응답하면 그
    // 바이트가 셸 입력 줄에 stray `R` 로 남는다 (전환·리로드마다 1개씩 누적).
    // 라이브 스트림의 새 질의는 replay 파싱 완료 후 도착하므로 정상 응답된다
    // (우리 resize nudge 가 유발하는 재동기화 질의 포함).
    this.onDataSub = this.term.onData((data) => {
      if (!this.replayDone) {
        console.debug("[mast] dropped stale terminal auto-response", data.length);
        return;
      }
      this.enqueueWrite(data);
    });

    // 2) attach → raw body [u64 LE end_offset][u8 first_attach][replay] 파싱.
    const body = await attachTerminal(this.session, channel);
    if (this.disposed) return; // attach 중 뷰가 해제됐으면 여기서 끝 (세션은 유지)
    const { endOffset, firstAttach, replay } = parseAttachBody(body);
    // 최초 attach 의 replay 질의는 라이브 질의 — 응답을 억제하면 conhost 가 CPR
    // 을 기다리며 셸이 멈춘다 (체크포인트 1 재시작 빈 화면: bytes_out=4 =
    // ESC[6n 만 출력된 채 정지, ESC[1;1R 수동 주입으로 해소된 실기 증거).
    // 재-attach 의 질의만 낡은 것이므로 그때만 replayDone 게이트로 억제한다.
    if (firstAttach) this.replayDone = true;
    const traceDone = this.onTraceReplayDone;
    if (replay.byteLength > 0) {
      const bytes = replay.byteLength;
      this.term.write(replay, () => {
        // 파싱 완료 — 이 시점부터의 onData 는 라이브 응답·사용자 입력이다.
        this.replayDone = true;
        // 첫 복원 (ADR-0019) — replay 가 그린 스크롤백 기준. nudge 재인쇄가
        // 이걸 밀어내면 이후 chunk 마다의 재적용이 다시 잡는다.
        this.applyScrollRestore();
        // 전환 계측 완료점 — replay write 완료 콜백 + rAF 1회 보정 (계획 A-2:
        // 실제 페인트가 아닌 근사, report 의 approximatePaint 가 명시).
        if (traceDone !== undefined) requestAnimationFrame(() => traceDone(bytes));
      });
    } else {
      this.replayDone = true;
      // replay 가 비어도 완료점은 알린다 (rAF 보정만) — trace 가 이 탭을 기다린다.
      if (traceDone !== undefined) requestAnimationFrame(() => traceDone(0));
    }
    // 3) 게이트 개방 — 큐잉분 판정·배출 (폐기분 즉시 ack 포함).
    this.applyGateResult(this.gate.onSnapshot(endOffset));
    this.onResizeSub = this.term.onResize(({ cols, rows }) => {
      resizeTerminal(this.session, cols, rows).catch((err) =>
        console.error("resize failed", err),
      );
    });

    // 4) resize nudge — SIGWINCH 재그리기 유도 (계획 0-2). 프론트는 PTY 의 현재
    //    크기를 모른다: 신규 스폰(80×24)이든 F5 리로드(직전 attach 의 실측 크기
    //    그대로)든 "실측 == PTY 현재 크기"인 경우 동일 크기 재설정은 no-op 이라
    //    SIGWINCH 가 나가지 않는다. 그래서 조건 없이 항상 rows-1 → rows 2단으로
    //    강제한다 — 리로드 후 TUI 재그리기가 이 nudge 의 존재 이유다.
    //    Exited 세션의 replay 표시에서는 resize 가 실패할 수 있으므로 attach 전체를
    //    무효화하지 않고 에러 로그만 남긴다 (다른 배선은 이미 정상).
    try {
      const { cols, rows } = this.term;
      await resizeTerminal(this.session, cols, Math.max(1, rows - 1));
      await resizeTerminal(this.session, cols, rows);
    } catch (err) {
      console.error("resize nudge failed", err);
    }

    // 이제부터는 재인쇄가 잠잠해지는 시점을 센다 — 그때가 복원을 끝내는
    // 지점이다 (ADR-0019).
    this.armScrollRestore();

    // 자동 focus 없음 (D7) — attach 전에 focus() 가 요청된 경우만 여기서 적용한다.
    // 숨은 상태로 attach 가 끝났으면 focus 는 버린다 (사용자가 이미 떠났다).
    if (this.focusPending) {
      this.focusPending = false;
      if (this.visible) this.term.focus();
    }
  }

  /** 뷰 해제 — 구독·xterm·배처를 정리한다. 세션은 죽이지 않는다
   *  (세션 수명은 dispatcher 소유 — 파일 상단 주석 참조). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unregisterTerminalFontTarget(this);
    this.endScrollRestore();
    // 뷰가 사라지므로 미뤄 둔 래치 해제도 의미가 없다 (xterm 자체가 곧 dispose).
    this.latchedByRestore = false;
    this.releaseLatchOnNextChunk = false;
    // 백엔드 채널 슬롯도 분리한다 — 채널을 남겨두면 이후 출력이 Delivered 인데
    // ack 는 없는 상태로 pending 이 쌓여 백그라운드 세션이 paused 에 고착된다
    // (리뷰 finding). 분리 후 출력은 Dropped(detach 모드)로 보상 롤백되며 replay
    // 에만 쌓인다. keep-alive 에서 dispose 는 탭이 스냅샷에서 사라졌을 때
    // (view-reconcile 의 dispose 목록)와 워크스페이스 이탈 시에만 호출된다 —
    // 탭 전환은 setVisible 로 처리되므로 "dispose 직후 같은 세션 재-attach"
    // (stale detach 가 새 attach 를 밟는 경합) 표면은 사실상 사라졌다. 남는
    // 유일한 재-attach 경로는 워크스페이스 복귀인데, 그때도 invoke 는 발행 순서
    // (detach 먼저 → 이후 렌더의 attach)로 처리되고 reattach 의 flow reset 이
    // 잔여를 정리한다.
    void detachTerminal(this.session).catch((err) =>
      console.error("detach_terminal failed", err),
    );
    this.onDataSub?.dispose();
    this.onDataSub = null;
    this.onResizeSub?.dispose();
    this.onResizeSub = null;
    // 남은 ack 집계는 배출하고 끝낸다 — 백엔드 flow 계정을 맞춘 채 떠난다.
    this.batcher.dispose();
    this.term.dispose();
    this.root.remove();
  }

  private onChunk(chunk: OutputChunk): void {
    if (this.disposed) return;
    const frame = parseFrame(chunk);
    this.applyGateResult(this.gate.push(frame));
  }

  private applyGateResult(result: GateResult): void {
    for (const bytes of result.deliver) {
      if (bytes.byteLength === 0) continue;
      // ack 은 write 완료 콜백에서 집계 — 렌더 소비 속도가 flow 에 반영된다.
      this.term.write(bytes, () => {
        this.batcher.add(bytes.byteLength);
        // 미뤄 둔 래치 해제 — **복원이 이미 끝났어도** 한다. 래치는 우리가 건
        // 것이라 푸는 것도 우리 책임이고, baseY 가 0 을 벗어난 지금이 브라우저
        // xterm 에서 해제가 실제로 먹는 첫 순간이다 (releaseScrollLatch 주석).
        if (this.releaseLatchOnNextChunk && this.term.buffer.active.baseY > 0) {
          this.releaseScrollLatchNow();
        }
        // 재인쇄가 잠잠해졌는지의 유일한 신호 (ADR-0019) — 도착이 아니라 파싱
        // 완료 시점이라, settle 이 끝났을 때 baseY 가 이미 최신이다.
        //
        // 그리고 매 chunk 마다 위치를 다시 맞춘다 (settle 무장 전후 모두 — 두
        // resize await 사이에 오는 것도 재인쇄 chunk 다). 재인쇄는 ESC[3J 로
        // 스크롤백을 지우고 다시 쌓으므로 중간 상태에서는 기억한 자리가 아직
        // 없는데, 그때마다 맨 아래로 따라붙였다가 자리가 생기면 되돌아간다 —
        // 그래서 어느 순간에 취소돼도 화면이 전사 맨 위에 얼어붙지 않는다.
        if (this.restoreOffset !== null) {
          const now = performance.now();
          this.settle.noteChunk(now);
          this.applyScrollRestore();
          this.rescheduleSettle(now);
        }
      });
    }
    // 폐기분도 수신은 했으므로 즉시 ack 집계 — 전량 ack 계약 (flow 계정 일치).
    this.batcher.add(result.discardedBytes);
  }

  private sendAck(n: number): void {
    ackOutput(this.session, n).catch((err) => console.error("ack_output failed", err));
  }

  /** 복사/붙여넣기 키 처리 — spike terminal-tile.ts 에서 그대로 이식.
   *  붙여넣기는 반드시 preventDefault 로 네이티브 paste 를 막고 클립보드 →
   *  term.paste() 단일 경로로 보낸다 — xterm 기본 처리(\x16 전송)와 네이티브
   *  paste 가 겹치면 무반응 또는 이중 붙여넣기가 된다. 복사는 선택이 있을 때만
   *  가로채고, 선택 없는 Ctrl+C 는 SIGINT 로 통과시킨다.
   *  여기에 Shift+Enter 재작성도 함께 산다 (아래 분기 주석 — 가로채기 목록은
   *  keys.ts 상단 표가 정본이다). */
  private installCopyPasteKeys(): void {
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // Shift+Enter → ESC CR("\x1b\r") 재작성. 터미널 프로토콜에는 Enter 와
      // Shift+Enter 를 구분할 방법이 없어 둘 다 CR 로 나가므로, Claude Code 는
      // 줄바꿈 삽입을 별도 시퀀스로 받는다 — 그 관례가 ESC CR 이고, Claude Code
      // 의 /terminal-setup 이 VS Code·iTerm2 에 심는 키 매핑과 같은 것을 여기서
      // 터미널 자체가 제공한다. plain Enter 는 건드리지 않으므로 vim·셸 등 일반
      // 앱의 개행·실행은 그대로다 (Shift+Enter 를 따로 쓰는 앱은 사실상 없다).
      if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        this.enqueueWrite("\x1b\r");
        return false; // xterm 기본 CR 전송 차단
      }
      if (isCopySelectionKey(ev, this.term.hasSelection())) {
        ev.preventDefault();
        void copyTerminalSelection(this.term);
        return false;
      }
      if (ev.key === "Insert") {
        // Windows 고전 조합 — 터미널 앱과 충돌하지 않는다.
        if (ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
          ev.preventDefault();
          void this.pasteFromClipboard();
          return false;
        }
        return true;
      }
      if (!ev.ctrlKey || ev.altKey) return true;
      if (ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        void this.pasteFromClipboard();
        return false;
      }
      return true;
    });
  }

  /** 붙여넣기 경로: 클립보드를 읽어 xterm paste 로 주입한다. WebView2 가
   *  clipboard-read 권한을 거부하는 환경이면 여기 로그가 그 증거가 되고, 그 경우
   *  Tauri clipboard-manager 플러그인 경로로 전환한다 (spike 검증 메모 승계).
   *
   *  클립보드에 **이미지가** 있으면 Ctrl+V 자체(\x16)를 PTY 로 흘려보낸다. 이미지
   *  붙여넣기는 터미널이 바이트를 날라 주는 일이 아니라 터미널 안의 앱이 OS 클립보드를
   *  스스로 읽는 일이기 때문이다 (Claude Code 는 xclip → wl-paste → powershell.exe 의
   *  Clipboard::GetImage 순으로 폴백하므로 WSL 에서도 Windows 클립보드를 읽는다). 즉
   *  터미널이 할 일은 키를 전달하는 것뿐이고, 여기서 키를 삼키면 그 경로가 아예
   *  시작되지 않는다.
   *
   *  "텍스트가 비었으면 보낸다" 가 아니라 이미지 유무를 확인하고 보내는 이유: 셸에서
   *  \x16 은 quoted-insert(다음 키를 리터럴로 먹는다)라, 빈 클립보드로 Ctrl+V 를 누른
   *  사람에게 그 상태를 물려주면 그냥 무반응이던 종전보다 나빠진다. 읽기가 실패한
   *  경우도 같은 이유로 아무것도 보내지 않는다. */
  private async pasteFromClipboard(): Promise<void> {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      // 여기서 return 하지 않는다 — 텍스트 포맷이 하나도 없는 클립보드에서 readText 가
      // 거부될 수 있고, 그게 바로 이 경로가 존재하는 이유인 이미지 전용 클립보드다.
      // 권한 거부가 원인이면 아래 clipboardHasImage 도 같이 실패해 결국 no-op 이라
      // 손해가 없다.
      console.error("clipboard read failed", err);
    }
    if (text.length > 0) {
      this.paste(text);
      return;
    }
    if (await clipboardHasImage()) this.enqueueWrite("\x16");
  }

  /** settle 무장 (nudge 직후 1회) — 여기서부터 "언제 복원을 끝낼지"를 센다.
   *  복원할 것이 없으면 아무 것도 걸지 않는다 — 평시 attach 에는 타이머도
   *  리스너도 생기지 않는다. */
  private armScrollRestore(): void {
    if (this.restoreOffset === null || this.disposed) return;
    const now = performance.now();
    this.settle.start(now);
    this.scheduleSettleCheck(this.settle.poll(now));
  }

  /** 상태기계의 답을 실행한다 — wait 면 그 시각에 다시 묻고, 아니면 끝낸다. */
  private scheduleSettleCheck(result: SettlePoll): void {
    switch (result.kind) {
      case "wait":
        this.settleTimer = setTimeout(
          () => {
            this.settleTimer = null;
            if (this.disposed) return;
            this.scheduleSettleCheck(this.settle.poll(performance.now()));
          },
          Math.max(0, result.nextCheckAt - performance.now()),
        );
        return;
      case "restore":
        this.applyScrollRestore();
        this.endScrollRestore();
        return;
      case "abandon":
        this.endScrollRestore();
        return;
    }
  }

  /** chunk 가 quiet 창을 밀 때마다 타이머를 다시 잡는다. 없으면 처음 예약한
   *  상한(2,000 ms) 시각에만 판정해 250 ms quiet 규칙이 영영 발화하지 않는다
   *  (peer review 2026-09-12). 대기 중일 때만 — 타이머가 없다는 것은 아직 무장
   *  전이거나 이미 끝났다는 뜻이고, 그때 poll 하면 abandon 이 나와 복원을 조기에
   *  죽인다. */
  private rescheduleSettle(now: number): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.scheduleSettleCheck(this.settle.poll(now));
  }

  /** 기억해 둔 위치로 되돌린다 — 끝내지는 않는다 (복원이 끝날 때까지 replay 직후·
   *  매 chunk·settle 완료가 같은 값으로 되부른다).
   *
   *  그 자리가 없으면 래치를 풀어 맨 아래로 보낸다 — 맨 아래 = 이 변경 전의
   *  동작이므로, 복원이 불가능한 탭은 정확히 종전대로 돌아온다. */
  private applyScrollRestore(): void {
    if (this.restoreOffset === null) return;
    const baseY = this.term.buffer.active.baseY;
    const line = restoreTargetLine(baseY, this.restoreOffset);
    if (line === null) {
      this.releaseScrollLatch();
      return;
    }
    this.term.scrollToLine(line);
    // 맨 아래보다 위로 보냈으면 xterm 이 isUserScrolling 을 걸었다.
    if (line < baseY) this.latchedByRestore = true;
  }

  /** 래치 해제 시도.
   *
   *  **브라우저 xterm 5.5 에서는 이동량이 0 이면 해제가 일어나지 않는다**:
   *  `scrollToBottom()` 은 `scrollLines(ybase - ydisp)` 이고, 소스가 USER 인 이
   *  경로는 `Viewport.scrollLines(e)` 로 가는데 그 함수가 `0 !== e` 에서 즉시
   *  돌아와 래치를 지우는 `BufferService.scrollLines`(`e + ydisp >= ybase` 에서
   *  해제)까지 닿지 못한다. 재인쇄의 `ESC[3J` 직후가 정확히 그 상태(ybase =
   *  ydisp = 0)라, 거기서 부르면 no-op 이고 래치만 남는다 — headless 빌드에는
   *  viewport 가 없어 그대로 해제되므로 실측이 이 차이를 가렸다.
   *  그래서 baseY 0 이면 다음 chunk 로 미룬다 (ybase 가 0 을 벗어나는 첫 순간이
   *  해제가 먹는 첫 순간이다). */
  private releaseScrollLatch(): void {
    if (this.term.buffer.active.baseY === 0) {
      this.releaseLatchOnNextChunk = true;
      return;
    }
    this.releaseScrollLatchNow();
  }

  private releaseScrollLatchNow(): void {
    this.term.scrollToBottom();
    this.latchedByRestore = false;
    this.releaseLatchOnNextChunk = false;
  }

  /** 복원 종료 — 완료·취소·dispose 공용의 단일 정리 지점. 이후 어느 경로가 늦게
   *  도착해도 restoreOffset 이 null 이라 아무 일도 하지 않는다. */
  private endScrollRestore(): void {
    this.restoreOffset = null;
    // 래치를 건 채 ESC[3J 직후(baseY 0)에 끝나면 지금은 풀 수 없다 — 다음 chunk
    // 로 미뤄야 pane 이 그 자리에 얼어붙지 않는다.
    if (this.latchedByRestore && this.term.buffer.active.baseY === 0) {
      this.releaseLatchOnNextChunk = true;
    }
    this.settle.cancel();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (!this.cancelListeners) return;
    this.cancelListeners = false;
    for (const type of RESTORE_CANCEL_EVENTS) {
      this.root.removeEventListener(type, this.onUserInterrupt, { capture: true });
    }
  }

  /** mousedown 은 스크롤바(`.xterm-viewport`) 위에서만 개입으로 본다 — 돌아온
   *  pane 을 클릭해 focus 를 주는 것은 스크롤 의도가 아니고, 그 클릭은 복원 창
   *  (2초) 안에 흔히 일어난다. 텍스트 위 mousedown 은 선택이지 스크롤이 아니다. */
  private readonly onUserInterrupt = (ev: Event): void => {
    if (ev.type === "mousedown") {
      const target = ev.target;
      if (!(target instanceof Element) || target.closest(".xterm-viewport") === null) return;
    }
    // 키로 취소한 경우에만 래치를 푼다 — 그 사용자는 "지금 여기서 계속"이 아니라
    // 입력을 시작한 것이고, 우리가 걸어 둔 래치를 그대로 두면 늦게 오는 재인쇄를
    // pane 이 따라가지 못한다. 휠·스크롤바 드래그는 반대다: 사용자가 자기 손으로
    // 만든 스크롤 위치이므로 건드리면 그 조작을 되돌리는 셈이 된다.
    if (ev.type === "keydown") this.releaseScrollLatch();
    this.endScrollRestore();
  };

  private installRestoreCancel(): void {
    if (this.restoreOffset === null || this.cancelListeners) return;
    this.cancelListeners = true;
    for (const type of RESTORE_CANCEL_EVENTS) {
      // capture: xterm 이 자기 핸들러에서 전파를 멈춰도 개입은 보여야 한다.
      this.root.addEventListener(type, this.onUserInterrupt, { capture: true, passive: true });
    }
  }

  private fit(): void {
    // 크기 0인 상태에서 fit 하면 잘못된 dims 가 잡히므로 보이는 상태에서만 수행.
    if (this.root.clientWidth === 0 || this.root.clientHeight === 0) return;
    this.fitAddon.fit();
  }
}
