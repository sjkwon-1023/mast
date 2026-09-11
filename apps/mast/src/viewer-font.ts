// 뷰어 글꼴 — settings.json 의 `fontFamily`/`fontSize` 를 뷰어의 **모노스페이스
// 콘텐츠 표면**에 적용하고, 런타임 줌(`Ctrl+=`/`Ctrl+-`/`Ctrl+0`)을 그 표면에
// **라이브로** 건다.
//
// 종전에는 이 두 값이 xterm 옵션에만 들어가서(terminal-view.ts
// applyTerminalSettings) 텍스트 뷰어의 행·폴더 목록·마크다운 code 는 styles.css 에
// 하드코딩된 `monospace` 12px 로 남았다 — 글꼴을 바꾼 사용자에게는 터미널만
// 바뀌고 뷰어는 그대로인 것이 결함으로 보인다 (필드 리포트). 설정 한 쌍이
// "이 앱에서 코드·로그를 읽을 때 쓰는 글꼴"을 뜻하도록 소비 범위를 넓힌다.
//
// 적용 방식은 **:root 커스텀 프로퍼티 한 쌍**이다. 부팅 경로가 값을 심고
// styles.css 가 `var(--viewer-font-family, monospace)` 꼴로 읽는다.
//
// - **설정이 미설정이면 아무 것도 심지 않는다** — 프로퍼티가 없으면 var() 의
//   fallback, 즉 종전 하드코딩 값이 그대로 쓰여 화면이 한 픽셀도 달라지지 않는다.
//   기본값을 CSS 와 TS 양쪽에 "심는" 구조로 만들지 않는 이유이기도 하다: 화면
//   기본값의 정본은 CSS 한 곳뿐이다. (줌이 한 번이라도 걸리면 그때부터는
//   `--viewer-font-size` 가 심긴 채로 남는다 — 아래 applyViewerFontSize 참조.)
// - **글꼴 family 의 대상은 모노스페이스 콘텐츠뿐이다** — 사이드바·탭바·버튼·
//   상태줄 같은 UI 크롬과 마크다운 산문은 사용자가 고른 "코드 글꼴"의 대상이
//   아니다. 반면 **크기**는 마크다운 산문도 따른다 (`.markdown-body` 가
//   `calc(var(--viewer-font-size, 12px) + 1px)`): 줌은 "지금 보는 이 문서를
//   키우는" 조작이라 산문만 제자리에 남으면 반쪽이다. 어떤 셀렉터가 어느 변수를
//   읽는지는 styles.css 가 정본이고 viewer-font.test.ts 가 그 목록을 잠근다.
// - **터미널은 이 경로를 타지 않는다** — xterm 은 자기 캔버스에 직접 그려 CSS 가
//   닿지 않으므로 종전대로 applyTerminalSettings 가 옵션에 넣는다. 두 경로가 같은
//   설정값을 읽지만 표면이 겹치지 않아 이중 적용이 아니다.
//
// ## 런타임 줌 (v0.3.8) — 종전의 "다시 부르지 말 것" 지뢰를 해체한 자리
//
// v0.3.7 의 이 모듈은 **부팅 1회 전용**이었고 "부팅 뒤에 다시 부르지 말 것"
// 경고를 달고 있었다: `--viewer-font-size` 는 라이브 CSS 변수라 글리프는 즉시
// 커지는데, 텍스트 뷰어 가상 스크롤의 행 격자(text-view.ts 의 `lineHeight`)는 뷰
// **생성 시 스냅샷**이라 spacer 높이·scrollTop 이 옛 크기에 남아 글자가 행을
// 넘치고 스크롤이 밀렸기 때문이다.
//
// 그 지뢰는 이제 없다. 이 모듈이 터미널 줌의 `liveViews` 에 상응하는 **뷰어
// 레지스트리**를 들고, 크기가 바뀔 때마다 등록된 뷰를 2단으로 부른다 —
// 변수를 갈기 **전에** 전량이 화면 위치를 붙들고(beforeViewerFontSize), 갈고 난
// **뒤에** 전량이 다시 앉는다(setViewerFontSize). 등록·해제는 뷰의 생성자와
// dispose 가 짝으로 맡는다.
//
// 등록 대상은 **크기가 바뀌면 좌표가 무의미해지는 뷰**다. 지금은 둘이다.
//
// - **TextView** — 행 격자를 TS 가 계산하므로(spacer 높이·scrollTop 이 행높이의
//   배수) CSS 만 갈면 글자가 행을 넘친다. 붙들 앵커는 없다: 모델 좌표가 byte
//   offset 이라 최상단 행 인덱스만 다시 계산하면 위치가 보존된다.
// - **MarkdownView** — 산문이 리플로우돼 문서 전체 높이가 바뀌는데 이 뷰의 스크롤
//   좌표는 **px** 다. 그대로 두면 줌 한 스텝(≈8%)마다 읽던 자리가 밀리고, 줌
//   아웃에서는 브라우저 클램프가 그 밀린 위치를 모델에 되쓴다 — 세션 한정이어야
//   할 줌이 재시작을 넘겨 사는 상태를 건드리게 된다. 그래서 상대 위치 앵커를
//   붙들었다가 되돌리고, 되돌린 px 는 모델에 보내지 않는다.
//
// FolderView 는 등록하지 않는다 — 행 높이가 내용에서 따라오고 스크롤 상태를
// 모델에 갖지 않아 CSS 변수만으로 온전히 따라온다.
//
// 줌 자체의 규율은 터미널과 같다.
//
// - **세션 한정** — settings.json 에 되쓰지 않는다 (백로그 결정 2026-08-12).
//   재시작하면 설정 파일의 값으로 돌아오고, `Ctrl+0` 은 그 값으로 되돌린다.
// - **클램프 6~72 정수** — 범위의 정본은 font-size.ts(→ 백엔드 FONT_SIZE_RANGE)다.
// - **키 1개가 두 표면을 같은 스텝으로** 움직인다 (터미널 + 뷰어). 표면별 독립
//   줌은 만들지 않는다 — 두 함수를 같이 부르는 자리는 main.ts runNavAction 한
//   곳이고, 키 판정은 keys.ts 가로채기 표가 정본이다. 두 표면의 **기준값**은
//   여전히 다르다(터미널 13px · 뷰어 12px): 같은 델타가 걸릴 뿐 같은 숫자를
//   공유하지는 않는다. 그래서 경계(6·72)에 한쪽만 먼저 걸리면 둘의 간격이
//   영구히 달라진다 — 바닥까지 줄였다 되올리면 13/12 차가 사라진다. 되돌리는
//   길은 `Ctrl+0` 뿐이고, 그것으로 충분하다고 본다 (간격 유지를 위해 한쪽을
//   경계 밖으로 내보내면 백엔드 범위 계약이 깨진다).

import { clampFontSize } from "./font-size";
import type { UiSettings } from "./backend";

/** 뷰어 모노스페이스 콘텐츠의 기본 글자 크기(px).
 *
 *  **styles.css 미러 계약**: `var(--viewer-font-size, 12px)` 를 쓰는 셀렉터들의
 *  fallback 과 같은 값이어야 한다. 화면의 정본은 CSS 쪽이고(설정도 줌도 없으면 이
 *  모듈은 아무 것도 심지 않는다), 이 상수는 **행 격자 계산**(text-view 의
 *  lineHeightForFontSize)이 "지금 몇 px 로 그려지는가"를 알아야 해서 있다 — 둘이
 *  갈라지면 행 높이가 글자 크기와 어긋나 행이 잘리거나 벌어진다. */
export const DEFAULT_VIEWER_FONT_SIZE = 12;

/** 지금 뷰어가 그려지는 글자 크기(px) — 줌이 움직이는 **유효 크기**다. */
let fontSize = DEFAULT_VIEWER_FONT_SIZE;
/** 줌 리셋(`Ctrl+0`)이 돌아갈 기준값 — settings.json 값(없으면 기본 12px). */
let baseFontSize = DEFAULT_VIEWER_FONT_SIZE;

/** 라이브 줌을 받아야 하는 뷰 — **글자 크기가 바뀌면 좌표가 무의미해지는 뷰만**
 *  해당한다. 지금은 둘이다: TextView(행 격자를 TS 가 계산한다)와 MarkdownView
 *  (산문이 리플로우돼 문서 높이가 바뀌는데 스크롤 좌표가 px 다). FolderView 는
 *  행 높이가 내용에서 따라오고 스크롤 상태를 모델에 갖지 않아 CSS 변수만으로
 *  충분하다 — 등록할 것이 없다. */
export interface ViewerFontTarget {
  /** 새 글자 크기(px)를 화면에 다시 앉힌다 — 격자 재계산·스크롤 복원까지 구현
   *  쪽 책임이다. 이 시점에는 `--viewer-font-size` 가 **이미 새 값**이므로 여기서
   *  읽는 레이아웃 값(scrollHeight 등)은 전부 줌 뒤 값이다. */
  setViewerFontSize(size: number): void;
  /** 크기가 바뀌기 **직전**에 불린다 (선택). CSS 변수가 아직 옛 값인 이 순간이
   *  "지금 어디를 보고 있었는가"를 되읽을 수 있는 유일한 지점이다 — 리플로우
   *  뒤에는 scrollTop 이 이미 클램프됐거나 문서 높이가 달라져 앵커를 만들 수
   *  없다. 붙들 것이 없는 뷰는 구현하지 않는다. */
  beforeViewerFontSize?(): void;
}

/** 살아있는 뷰 레지스트리 (터미널 줌의 liveViews 에 상응) — 줌은 "지금 열려 있는
 *  모든 뷰"에 동시에 걸리므로 인스턴스 목록이 필요하다. dispose 된 뷰가 남아
 *  떨어진 DOM 을 건드리지 않도록 등록·해제는 반드시 짝으로 부른다. */
const liveViews = new Set<ViewerFontTarget>();

/** 뷰 생성자가 자신을 등록한다 — 해제는 dispose 의 unregisterViewerFontTarget. */
export function registerViewerFontTarget(view: ViewerFontTarget): void {
  liveViews.add(view);
}

export function unregisterViewerFontTarget(view: ViewerFontTarget): void {
  liveViews.delete(view);
}

/** 뷰어 글자 크기(px). 픽셀 격자를 **직접 계산**하는 뷰(text-view 의 가상
 *  스크롤)만 쓴다 — 글꼴만 따르면 되는 표면은 CSS 변수로 충분하다.
 *
 *  줌 뒤에 새로 열리는 뷰도 이 값을 읽으므로 **현재 줌 크기로 열린다** (한 창
 *  안에서 탭마다 글자 크기가 다른 상태를 만들지 않는다 — 터미널 줌과 같은 규율). */
export function viewerFontSize(): number {
  return fontSize;
}

/** settings.json 의 글꼴 설정을 뷰어 표면에 적용한다 (main.ts 부트가 **뷰 생성
 *  전에** 호출 — applyTerminalSettings·applyHighlightSettings 와 같은 자리·같은
 *  순서 계약: 뷰는 첫 스냅샷 렌더부터 생기므로 그 전에 심어야 모든 탭이 같은
 *  글꼴로 열린다).
 *
 *  값 검증은 백엔드(`get_ui_settings`)가 이미 했다 — 여기서 다시 판정하면 두 곳의
 *  규칙이 갈라진다 (형제 함수들과 같은 규율).
 *
 *  **null 은 "기본값으로"다.** 형제 함수들은 null 을 "현재 값 유지"로 다루지만,
 *  이 함수는 total 이라 프로퍼티를 심지 않은 상태(= CSS fallback)로 되돌릴 수
 *  있다. 그래서 이 호출은 줌까지 **기준값으로 되감는다** — 설정을 다시 읽는다는
 *  것은 "파일이 말하는 상태로 맞춘다"는 뜻이고, 세션 한정인 줌이 그 위에 남아
 *  있으면 안 된다.
 *
 *  **부팅 뒤에 다시 불러도 안전하다** (v0.3.8). 종전의 "다시 부르지 말 것" 경고는
 *  살아 있는 TextView 의 행 격자를 다시 앉힐 경로가 없었기 때문인데, 이제 그
 *  경로(레지스트리 + setViewerFontSize)가 있고 이 함수도 그것을 탄다.
 *
 *  단 **짝인 applyTerminalSettings 는 아직 부팅 1회 전용**이다 — 그쪽은 살아있는
 *  xterm 에 밀지 않고 null 을 "현재 값 유지"로 다뤄 줌을 되감지도 않는다. 설정
 *  리로드 기능을 붙일 때 이 함수만 부르면 뷰어만 줌이 풀리고 터미널은 남는 반쪽
 *  동작이 되므로, 그때 terminal-view 쪽도 같이 라이브로 만들어야 한다.
 *
 *  줌 경로와 달리 **크기가 그대로여도 뷰에 민다**: family 만 바뀌어도 산문은
 *  리플로우되므로 앵커를 되돌릴 기회가 필요하다 (크기만 보고 건너뛰면 마크다운이
 *  읽던 자리를 잃는다). 격자가 그대로인 뷰는 자기 쪽에서 조용히 빠진다. */
export function applyViewerFontSettings(settings: UiSettings): void {
  // 앵커는 **어떤 변수든 갈기 전에** 붙든다 — family 교체도 글리프 폭이 달라져
  // 산문을 리플로우시키므로 크기 못지않게 화면 위치를 흔든다.
  captureAnchors();
  const root = document.documentElement;
  setVariable(root, "--viewer-font-family", settings.fontFamily);
  setVariable(
    root,
    "--viewer-font-size",
    settings.fontSize === null ? null : `${settings.fontSize}px`,
  );
  baseFontSize = settings.fontSize ?? DEFAULT_VIEWER_FONT_SIZE;
  fontSize = baseFontSize;
  pushFontSize(fontSize);
}

/** 줌 ±1px (`Ctrl+=` / `Ctrl+-`) — 터미널 줌(adjustFontSize)의 뷰어 짝이다.
 *  현재 유효 크기에 delta 를 더해 클램프하고 살아있는 모든 뷰에 적용한다. */
export function adjustViewerFontSize(delta: number): void {
  applyViewerFontSize(clampFontSize(fontSize + delta));
}

/** 줌 리셋 (`Ctrl+0`) — settings.json 값(없으면 기본 12px)으로 되돌린다.
 *  "0 = 원래대로"의 원래는 앱 기본값이 아니라 **사용자가 설정한 값**이다. */
export function resetViewerFontSize(): void {
  applyViewerFontSize(baseFontSize);
}

/** 줌 경로의 크기 적용. 값이 그대로면(경계에 걸렸거나 이미 그 크기) 아무 것도
 *  하지 않는다 — 무변경 재적용은 떠 있는 뷰의 재렌더만 낭비한다.
 *
 *  설정 경로와 달리 **프로퍼티를 항상 심는다**: 줌은 "지금 이 크기로 그려라"라서
 *  미설정 상태로 되돌릴 수 없다. 기준값이 기본값과 같은 상태에서 리셋해 12px 를
 *  심게 되더라도 그 값은 CSS fallback 과 같은 값이라(위 미러 계약 —
 *  viewer-font.test.ts 가 잠근다) 화면은 미설정과 동일하다. */
function applyViewerFontSize(size: number): void {
  if (size === fontSize) return;
  captureAnchors();
  fontSize = size;
  document.documentElement.style.setProperty("--viewer-font-size", `${size}px`);
  pushFontSize(size);
}

/** 변수를 갈기 직전, 살아있는 뷰 전체에 화면 위치를 붙들 기회를 준다.
 *
 *  **전량을 먼저** 붙든 뒤에 변수를 간다: 뷰마다 "붙들고 → 앉히고"를 번갈아 하면
 *  첫 뷰가 강제한 레이아웃 때문에 뒤의 뷰들은 이미 새 크기를 읽어 앵커가 무의미
 *  해진다. 그래서 이 루프와 pushFontSize 루프가 따로 있다. */
function captureAnchors(): void {
  for (const view of liveViews) view.beforeViewerFontSize?.();
}

/** 살아있는 뷰 전체에 새 크기를 민다 (격자 재계산·스크롤 복원은 각 뷰의 몫). */
function pushFontSize(size: number): void {
  for (const view of liveViews) view.setViewerFontSize(size);
}

/** 값이 있으면 심고, 없으면 **지운다**. 빈 문자열을 심는 것과 다르다 — 빈 값도
 *  "설정됨"이라 var() 의 fallback 이 발동하지 않고 선언 자체가 무효가 된다. */
function setVariable(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}
