// 키보드 판정 — DOM 무의존 순수 모듈 (20단계, 계획 v2 "키보드 모델" 장).
//
// 3층 구조(워크스페이스 / pane / 탭)의 이동 키와, 마우스로만 되던 조작
// (탭 생성·닫기·분할·새 워크스페이스)의 전역 단축키를 한곳에서 판정한다.
// 여기서 계산하는 건 "이 keydown 이 어떤 동작인가"와 "그 이동의 대상이
// 무엇인가"까지고, 스냅샷 해석·dispatch·preventDefault 배선은 main.ts 글루,
// pane 기하 실측은 workspace-view 의 paneRects() 가 맡는다.
//
// ## 키보드 가로채기 목록 (canonical — 계획 v2 "키보드 가로채기 목록" 장)
//
// 앱이 가로채는 키의 **전량**이다. 여기 없는 키는 전부 터미널(PTY) 소유다.
// 가로채기를 추가·변경하면 이 표를 같이 갱신한다 (목록과 코드를 한곳에 두기
// 위한 계약 — 표가 정본이다).
//
// | 키 | 동작 | 가로채는 곳 |
// |---|---|---|
// | `Ctrl+1`~`Ctrl+9` | 워크스페이스 전환 (사이드바 순서 1-based) | keys.ts 판정 + main.ts window keydown capture |
// | `Alt+↑` `Alt+↓` `Alt+←` `Alt+→` | pane 포커스 이동 (기하학적 인접) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 활성 pane 의 탭 순환 (다음/이전, 끝에서 순환) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+W` | 활성 pane 의 활성 탭 닫기 (뷰어 탭 포함) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+T` | 활성 pane 에 새 터미널 탭 | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+B` | 활성 pane 에 새 폴더 탐색 탭 | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+D` | 활성 pane 상하 분할 + 터미널 탭 | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+E` | 활성 pane 좌우 분할 + 터미널 탭 | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+N` | 새 워크스페이스 — 활성 터미널의 현재 경로로 즉시 생성 (임의 폴더는 사이드바 + 버튼의 픽커) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+[` / `Ctrl+Shift+]` | 이전/다음 워크스페이스 (사이드바 순서, 끝에서 순환) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+Q` | 활성 워크스페이스 닫기 (실행 중인 터미널 세션이 있으면 confirm — 사이드바 × 버튼과 같은 경로) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+=` / `Ctrl++` | 터미널 **+ 뷰어** 글꼴 확대 (세션 한정 — settings.json 은 그대로) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+-` | 터미널 **+ 뷰어** 글꼴 축소 (세션 한정) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+0` | 터미널·뷰어 글꼴 크기를 각자의 settings.json 기준값으로 리셋 | keys.ts 판정 + main.ts window keydown capture |
// | `F2` | 활성 워크스페이스 이름 변경 (사이드바 카드 인라인 편집) | keys.ts 판정 + main.ts window keydown capture |
// | `Ctrl+Shift+R` | WebView 리로드 (F5 는 쓰지 않는다 — main.ts 주석 참조) | main.ts installReloadKey |
// | `Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert` | 붙여넣기 (클립보드 → xterm paste) | terminal-view.ts customKeyEventHandler |
// | `Ctrl+C` / `Ctrl+Shift+C` / `Ctrl+Insert` (선택 있을 때만) | 복사 — 선택 없는 `Ctrl+C` 는 SIGINT 로 통과 | terminal-view.ts customKeyEventHandler |
// | `Shift+Enter` (터미널 내) | ESC CR 재작성 — Claude Code 줄바꿈 관례 | terminal-view.ts customKeyEventHandler |
// | `Esc` (send-mode 활성 중에만 — **현재 UI 진입점 없음: 휴면**) | 전달 대상 선택 취소 — 평시 Esc 는 PTY 소유 | workspace-view.ts (모드 활성 중에만 설치) |
// | `Ctrl+PgUp` / `Ctrl+PgDn` (textViewer 포커스 중에만) | 이전/다음 512KiB 윈도우 | text-view.ts 뷰 내부 keydown |
// | `Ctrl+Home` / `Ctrl+End` (textViewer 포커스 중에만) | 처음/마지막 윈도우 | text-view.ts 뷰 내부 keydown |
// | `PgUp` / `PgDn` (textViewer 포커스 중에만) | 행높이 배수 페이지 스크롤 | text-view.ts 뷰 내부 keydown |
// | `↑↓ Home End PgUp PgDn Enter Backspace` (folderBrowser 포커스 중에만) | 목록 선택 이동·열기·상위 이동 | folder-view.ts 뷰 내부 keydown |
//
// modifier 규약: 앱 전역 단축키는 **`F2` 하나를 제외하고 전부 `Ctrl+Shift`
// 계열**이다. plain `Ctrl` 조합은 셸 소유로 남긴다 — `Ctrl+W` 는 bash 의 단어
// 삭제, `Ctrl+D` 는 EOF, `Ctrl+E` 는 행 끝 이동이라 뺏으면 터미널을 망가뜨린다.
// `Ctrl+Shift+C` · `Ctrl+Shift+V` 는 복사·붙여넣기 관례라 절대 배정하지 않고
// (terminal-view 소유), `Ctrl+Shift+R` 은 리로드(main.ts 소유)라 여기서 판정하지
// 않는다.
//
// **줌 3키의 예외 (명시)**: `Ctrl+=` · `Ctrl+-` · `Ctrl+0` 은 위 규약을 깨고 plain
// `Ctrl` 계열이다 — 확대/축소/원래대로는 브라우저·에디터 전반의 관례라 `Ctrl+Shift`
// 로 옮기면 아무도 찾지 못한다. 대가는 알고 받아들인다: `Ctrl+-` 는 터미널의 `C-_`
// (bash·emacs 의 undo)를 가려 그 앱들에 영영 닿지 않고, `Ctrl+=`·`Ctrl+0` 도 같은
// 값을 쓰는 앱에서 마찬가지다. `Ctrl+1`~`Ctrl+9` 와 같은 트레이드오프 계열이다
// (되돌린다면 이 표와 keyAction 의 줌 블록을 함께 고친다).
//
// **`F2` 의 트레이드오프 (명시)**: 무수식 F2 는 터미널 앱이 실제로 쓰는 키다
// (mc 의 Rename, 기능키 행을 쓰는 TUI) — 가로채면 그 앱들에 F2 가 영영 닿지
// 않는다. 이 비용을 알고 받아들인 선택이다: "이름 변경 = F2" 는 데스크톱 전반의
// 관례라 대체 키로는 발견되지 않고, F2 를 쓰는 TUI 는 F5 만큼 흔하지 않다.
// F5 를 리로드로 쓰지 않은 판단(대체 키 Ctrl+Shift+R 가 있었다)과 결론이 갈리는
// 자리라 여기 남긴다 — 이름 변경에는 동급의 관례 대체 키가 없다. 되돌린다면
// 이 표와 CTRL_SHIFT_KEYS 를 함께 고치면 된다 (판정·표시 단일 소스).
//
// shift 규약: shift 를 받는 조합은 `Ctrl+Shift+Tab` · 위 `Ctrl+Shift+<문자>` 9종 ·
// 확대 키의 `+`(US 배열에서 `Shift+=` 로 오는 문자)뿐이다.
// `Ctrl+Shift+1`·`Alt+Shift+←` 같은 변형은 판정 대상이 아니다(null) —
// shift 는 레이아웃에 따라 다른 문자를 만들 수 있어 보수적으로 목록에 명시된
// 조합만 가로챈다. `[`·`]` 는 그 예외를 정면으로 만나는 자리라 표기 문자와
// **shift 결과 문자**(`{`·`}`)를 둘 다 매칭한다 (아래 CTRL_SHIFT_KEYS 참조).

import type { Pane, PaneId, SplitDirection, TabId, Workspace, WorkspaceId } from "./types";

/** keydown 판정 입력 — KeyboardEvent 의 구조적 부분집합 (DOM 없이 테스트하기
 *  위한 최소 형태). 실코드에서는 이벤트의 key/ctrlKey/altKey/shiftKey/isComposing
 *  을 그대로 옮겨 담으면 된다. */
export interface KeySpec {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** IME 조합 중 여부 — 조합 중의 키는 조합기 소유라 가로채지 않는다. */
  isComposing: boolean;
}

/** pane 이동 방향 — 화면 기하 기준 (Alt+방향키). */
export type PaneDirection = "up" | "down" | "left" | "right";

/** 판정 결과. ordinal 은 1-based 사이드바 순서, delta 는 탭 순환 방향이다.
 *  대상 해석(그 ordinal 의 워크스페이스가 있는가, 활성 pane 이 무엇인가 등)은
 *  글루의 몫 — 여기서는 키가 무슨 동작을 뜻하는지까지만 정한다. */
export type KeyAction =
  | { type: "switchWorkspace"; ordinal: number }
  | { type: "focusPane"; dir: PaneDirection }
  | { type: "cycleTab"; delta: 1 | -1 }
  /** 활성 pane 의 활성 탭 닫기 — 종류 무관(뷰어 탭 포함), 탭 × 버튼과 같은 명령. */
  | { type: "closeTab" }
  /** 활성 pane 에 새 탭 — kind 는 NewTab 의 종류 이름을 그대로 쓴다. */
  | { type: "newTab"; kind: "terminal" | "folderBrowser" }
  /** 활성 pane 분할 + 새 터미널 탭 (원자 SplitPane — 헤더 분할 아이콘과 동일). */
  | { type: "splitPane"; direction: SplitDirection }
  /** 사이드바 순서로 이전/다음 워크스페이스 (끝에서 순환) — 대상 해석은 글루. */
  | { type: "cycleWorkspace"; delta: 1 | -1 }
  /** 활성 터미널의 현재 경로로 새 워크스페이스를 즉시 만든다 (대화상자 없음 —
   *  사용자 결정 2026-08-11: 키보드 흐름은 "지금 있는 곳에서 바로", 임의 폴더는
   *  사이드바 + 버튼의 픽커가 담당한다). cwd 해석·dispatch 는 글루 몫이다. */
  | { type: "newWorkspaceHere" }
  /** 활성 워크스페이스 닫기 — 사이드바 × 버튼과 **같은 명령**이다. 실행 중인
   *  터미널 세션이 있으면 confirm 을 거치는데, 그 판정·문구는 × 버튼 구현
   *  (sidebar.ts 의 onClose)이 단일 소스라 글루가 그쪽을 그대로 부른다. */
  | { type: "closeWorkspace" }
  /** 활성 워크스페이스 이름의 인라인 편집 시작 — dispatch 가 아닌 UI 액션이다
   *  (편집 확정 시점에 글루가 renameWorkspace 를 보낸다). */
  | { type: "renameWorkspace" }
  /** 글꼴 크기 ±1px (`Ctrl+=`/`Ctrl++` · `Ctrl+-`) — **터미널과 뷰어 둘 다**를
   *  같은 스텝으로 움직인다 (표면별 독립 줌은 없다). 클램프·적용은 terminal-view
   *  ·viewer-font 의 모듈 상태 소관이고, 상태 스냅샷과 무관한 UI 액션이다. */
  | { type: "zoom"; delta: 1 | -1 }
  /** 터미널·뷰어 글꼴 크기를 각자의 settings.json 기준값으로 되돌린다 (`Ctrl+0`).
   *  두 표면의 기준값은 서로 다를 수 있다 (터미널 기본 13px · 뷰어 12px). */
  | { type: "zoomReset" };

const ARROW_DIRS: Record<string, PaneDirection | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** 워크스페이스 전환 키의 ordinal 범위 (`Ctrl+1`~`Ctrl+9` — `Ctrl+0` 은 이 범위가
 *  아니라 줌 리셋이다. 아래 줌 블록이 먼저 판정한다). */
const DIGIT_KEY = /^[1-9]$/;

/** `Ctrl+Shift+<문자>` 단축키의 식별자 — 툴팁이 라벨을 요청할 때 쓰는 키다. */
export type ShortcutId =
  | "closeTab"
  | "newTerminalTab"
  | "newFolderTab"
  | "splitTopBottom"
  | "splitLeftRight"
  | "newWorkspace"
  | "prevWorkspace"
  | "nextWorkspace"
  | "closeWorkspace";

/** `Ctrl+Shift+<문자>` 단축키 표 (canonical) — 판정(keyAction)과 표시
 *  (shortcutLabel)가 같은 표를 읽으므로 버튼 툴팁이 실제 키와 어긋날 수 없다.
 *  letter 는 소문자 기준이고 매칭은 대소문자를 무시한다 (Shift 가 눌린 keydown 은
 *  `ev.key` 가 대문자로 온다).
 *
 *  shifted 는 "그 키를 Shift 와 함께 누르면 브라우저가 주는 다른 문자"다 —
 *  `[`·`]` 는 `ev.key` 가 `{`·`}` 로 오므로 둘 다 받아야 한다. 표기(라벨)는
 *  언제나 letter 쪽이다.
 *
 *  action 이 값이 아니라 팩토리인 이유: 호출자에게 표의 객체를 그대로 넘기면
 *  외부 변형이 표를 오염시킬 수 있어, 매 판정마다 새 객체를 만든다. */
const CTRL_SHIFT_KEYS: Record<
  ShortcutId,
  { letter: string; shifted?: string; action: () => KeyAction }
> = {
  closeTab: { letter: "w", action: () => ({ type: "closeTab" }) },
  newTerminalTab: { letter: "t", action: () => ({ type: "newTab", kind: "terminal" }) },
  newFolderTab: { letter: "b", action: () => ({ type: "newTab", kind: "folderBrowser" }) },
  // 방향 규약은 split-layout.ts 상단 — "vertical" = 세로 나열(상/하),
  // "horizontal" = 가로 나열(좌|우). 헤더의 ⊟/◫ 아이콘과 같은 값을 보낸다.
  splitTopBottom: { letter: "d", action: () => ({ type: "splitPane", direction: "vertical" }) },
  splitLeftRight: { letter: "e", action: () => ({ type: "splitPane", direction: "horizontal" }) },
  newWorkspace: { letter: "n", action: () => ({ type: "newWorkspaceHere" }) },
  prevWorkspace: {
    letter: "[",
    shifted: "{",
    action: () => ({ type: "cycleWorkspace", delta: -1 }),
  },
  nextWorkspace: {
    letter: "]",
    shifted: "}",
    action: () => ({ type: "cycleWorkspace", delta: 1 }),
  },
  closeWorkspace: { letter: "q", action: () => ({ type: "closeWorkspace" }) },
};

/** 버튼 툴팁에 붙일 단축키 표기 — 표시 문자열의 **단일 소스**다. UI 는 이 함수를
 *  거치지 않고 단축키를 하드코딩하지 않는다 (키를 바꿔도 툴팁이 따라온다). */
export function shortcutLabel(id: ShortcutId): string {
  return `Ctrl+Shift+${CTRL_SHIFT_KEYS[id].letter.toUpperCase()}`;
}

/** pane 의 표시 탭이 터미널이면 그 cwd — OSC 7 이 배선돼 있으면 마지막 프롬프트 시점의
 *  경로(ADR-0011), 아니면 스폰 시점 경로 — 뷰어·빈 pane 이면 null. null 은 NewTab 의
 *  "워크스페이스 rootPath" 기본값과 같은 뜻이라 그대로 넘길 수 있다. 새 터미널 탭·분할이
 *  그 pane 의 셸이 있는 곳에서 열리게 하는 해석은 코어가 아니라 여기서 한다 — 코어의
 *  `cwd: None → root_path` 계약과 그 테스트를 건드리지 않는 쪽이 가벼워서다 (사용자 결정
 *  2026-09-05). */
export function paneTerminalCwd(pane: Pane | undefined): string | null {
  const active = pane?.activeTab ?? null;
  const tab = active === null ? undefined : pane?.tabs.find((t) => t.id === active);
  return tab !== undefined && tab.kind.type === "terminal" ? tab.kind.cwd : null;
}

/** `Ctrl+Shift+N` 의 경로 해석 (순수) — 활성 pane 의 터미널 cwd, 아니면 워크스페이스
 *  rootPath. 둘 다 없으면 null — 글루가 에러로 표면화한다. */
export function activeTerminalCwd(ws: Workspace): string | null {
  return paneTerminalCwd(ws.panes[String(ws.activePane)]) ?? ws.rootPath;
}

/** 리눅스 경로의 마지막 세그먼트 — 새 워크스페이스 기본 이름 (글루
 *  `commands.rs::folder_name` 의 프론트 짝, 루트는 "/" 그대로). */
export function pathBasename(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "/";
}

/** keydown → 액션. 가로채기 목록에 없는 조합은 전부 null 이고, 그때 글루는
 *  이벤트에 손대지 않는다 (터미널로 그대로 흘려보낸다). */
export function keyAction(spec: KeySpec): KeyAction | null {
  // IME 조합 중의 키는 전부 통과시킨다 — 한글 입력 중의 조합 키가 이동으로
  // 오판돼 조합을 깨뜨리면 안 된다.
  if (spec.isComposing) return null;
  if (spec.ctrl && !spec.alt && spec.key === "Tab") {
    return { type: "cycleTab", delta: spec.shift ? -1 : 1 };
  }
  if (spec.ctrl && spec.shift && !spec.alt) {
    // Shift 가 눌린 keydown 의 key 는 대문자라 소문자로 접어 비교한다. 표에 없는
    // 조합(`Ctrl+Shift+C`/`V` 복사·붙여넣기, `Ctrl+Shift+R` 리로드)은 여기서
    // 걸리지 않고 각자의 소유자에게 그대로 흘러간다.
    const letter = spec.key.toLowerCase();
    for (const def of Object.values(CTRL_SHIFT_KEYS)) {
      if (def.letter === letter || def.shifted === letter) return def.action();
    }
  }
  // 터미널 줌 3키 — plain Ctrl 계열이다 (파일 상단 "줌 3키의 예외" 참조).
  // `+` 는 US 배열에서 `Shift+=` 로 오므로 확대만 shift 를 허용한다: 사용자는
  // `Ctrl` 을 쥔 채 `+` 라고 적힌 키를 누르지, `=` 를 누른다고 생각하지 않는다.
  // 축소·리셋은 shift 없이만 받는다 (`Ctrl+Shift+-` 의 `_`, `Ctrl+Shift+0` 의 `)`
  // 는 판정 대상이 아니고 그대로 터미널로 간다).
  if (spec.ctrl && !spec.alt) {
    if (spec.key === "+") return { type: "zoom", delta: 1 };
    if (!spec.shift) {
      if (spec.key === "=") return { type: "zoom", delta: 1 };
      if (spec.key === "-") return { type: "zoom", delta: -1 };
      if (spec.key === "0") return { type: "zoomReset" };
    }
  }
  // 여기부터는 shift 변형을 받지 않는다 (파일 상단 shift 규약).
  if (spec.shift) return null;
  // F2 = 활성 워크스페이스 이름 변경 (무수식 — 파일 상단의 트레이드오프 참조).
  if (spec.key === "F2" && !spec.ctrl && !spec.alt) {
    return { type: "renameWorkspace" };
  }
  if (spec.ctrl && !spec.alt && DIGIT_KEY.test(spec.key)) {
    return { type: "switchWorkspace", ordinal: Number(spec.key) };
  }
  if (spec.alt && !spec.ctrl) {
    const dir = ARROW_DIRS[spec.key];
    if (dir !== undefined) return { type: "focusPane", dir };
  }
  return null;
}

/** pane 의 화면 기하 — DOMRect 의 구조적 부분집합. workspace-view 가
 *  getBoundingClientRect 로 채운다 (레이아웃 트리 대신 실측을 쓰는 이유는
 *  paneRects() 주석 참조). */
export interface PaneRect {
  pane: PaneId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 방향 이동 대상 — from 중심을 기준으로 그 방향 반평면에 중심이 있는 pane 중
 *  중심 간 유클리드 거리가 최소인 것. 후보가 없거나(가장자리 pane·단일 pane)
 *  from 이 목록에 없으면 null 이고, 글루는 조용한 no-op 으로 끝낸다.
 *
 *  반평면 판정은 엄격 부등호다 — 중심 좌표가 같은 pane 은 그 방향의 후보가
 *  아니다. 거리 동률은 목록에서 먼저 나온 pane 이 이긴다 (렌더 순서 = 문서 순서). */
export function paneInDirection(
  rects: PaneRect[],
  from: PaneId,
  dir: PaneDirection,
): PaneId | null {
  const origin = rects.find((r) => r.pane === from);
  if (origin === undefined) return null;
  const ox = origin.x + origin.w / 2;
  const oy = origin.y + origin.h / 2;
  let best: PaneId | null = null;
  let bestDist = Infinity;
  for (const r of rects) {
    if (r.pane === from) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const inDir =
      dir === "left" ? cx < ox : dir === "right" ? cx > ox : dir === "up" ? cy < oy : cy > oy;
    if (!inDir) continue;
    const dist = Math.hypot(cx - ox, cy - oy);
    if (dist < bestDist) {
      bestDist = dist;
      best = r.pane;
    }
  }
  return best;
}

/** 1-based ordinal → 워크스페이스 id. 사이드바 카드 순서 = `state.workspaces`
 *  배열 순서라 인덱싱으로 충분하다. 범위를 벗어나면 null (조용한 no-op). */
export function workspaceAtOrdinal(
  workspaces: WorkspaceId[],
  ordinal: number,
): WorkspaceId | null {
  const found = workspaces[ordinal - 1];
  return found === undefined ? null : found;
}

/** 탭 순환 대상 — tabs 는 pane 의 탭 순서, active 는 그 pane 의 활성 탭.
 *  끝에서 순환하고, 탭이 0~1개거나 active 가 목록에 없으면 null (no-op). */
export function nextTab(tabs: TabId[], active: TabId | null, delta: 1 | -1): TabId | null {
  return cycle(tabs, active, delta);
}

/** 워크스페이스 순환 대상 (`Ctrl+Shift+[` / `]`) — workspaces 는 사이드바 순서,
 *  active 는 현재 활성 워크스페이스. 탭 순환과 같은 규칙이다: 끝에서 순환하고,
 *  워크스페이스가 0~1개거나 active 가 목록에 없으면 null (조용한 no-op — 하나뿐인
 *  워크스페이스로 "전환"해 무변경 revision 을 만들지 않는다). */
export function nextWorkspace(
  workspaces: WorkspaceId[],
  active: WorkspaceId | null,
  delta: 1 | -1,
): WorkspaceId | null {
  return cycle(workspaces, active, delta);
}

/** 안정 ID 목록의 순환 이웃 — nextTab·nextWorkspace 공통 구현 (같은 규칙이
 *  두 벌로 갈라지지 않게 한다). */
function cycle(ids: number[], active: number | null, delta: 1 | -1): number | null {
  if (ids.length < 2 || active === null) return null;
  const idx = ids.indexOf(active);
  if (idx < 0) return null;
  return ids[(idx + delta + ids.length) % ids.length];
}
