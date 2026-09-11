// 글꼴 크기 클램프 — 터미널 줌(terminal-view)과 뷰어 줌(viewer-font)이 **같은
// 규칙**을 쓴다는 것이 이 모듈의 존재 이유다. 두 표면은 유효 크기도 기준값도
// 따로 들고 있지만(터미널 기본 13px · 뷰어 기본 12px), 한 번의 키 입력이 둘을
// 같은 스텝으로 움직이므로 허용 범위가 갈라지면 한쪽만 먼저 멈춘다.
//
// 이 파일을 따로 둔 이유는 **의존 방향**이다: 클램프를 terminal-view 에 두면
// 뷰어 모듈이 xterm 을 통째로 끌고 오고(그 모듈은 로드만으로 `self` 를 읽는
// UMD 래퍼가 딸려 온다 — terminal-view.test.ts 머리 주석), viewer-font 에 두면
// 터미널이 뷰어에 의존하는 이름의 거짓말이 된다.

/** 허용 글꼴 크기(px) — **백엔드와의 동기화 계약**: `src-tauri/src/commands.rs`
 *  의 `FONT_SIZE_RANGE`(6..=72)와 같은 값이어야 한다. 그쪽은 settings.json 의
 *  fontSize 를 검증해 범위 밖이면 부트에서 에러로 표면화하고, 여기는 런타임 줌이
 *  그 범위를 넘지 않게 막는다 — 갈라지면 줌으로만 도달 가능한 크기가 생겨
 *  "설정으로는 못 쓰는 값이 화면에는 있는" 비일관이 된다. 한쪽을 바꾸면 둘 다
 *  바꾼다. */
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 72;

/** 줌 후 글꼴 크기 (순수) — 클램프 규칙의 단일 소스다. 테스트는 terminal-view 가
 *  다시 내보내는 이름을 잡는다 (terminal-view.test.ts — 그 파일은 xterm 을
 *  import 하므로 happy-dom 환경이고, 이 모듈만 쓰는 새 테스트는 그럴 필요가 없다).
 *  정수 px 로 유지한다 (xterm 이 소수 크기도 받지만 셀 폭 반올림이 fit 계산과
 *  어긋나기 쉽고, 뷰어 쪽은 행높이가 이 값에서 파생하는 정수 격자다). 범위를
 *  벗어난 요청은 에러가 아니라 경계에 멈춘다 — 키를 더 눌러도 아무 일이 없는 것
 *  자체가 피드백이다 (키보드 조작의 조용한 no-op 규율). */
export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}
