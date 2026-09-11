// 인코더가 읽는 단말 모드 — xterm `Terminal.modes` 중 우리가 쓰는 두 개만
// 추린 구조다. 인코더(protocol.ts)를 xterm 타입에서 떼어 놓기 위한 것으로,
// 그래야 인코더 테스트가 DOM 없이 돈다.

export interface TerminalModes {
  bracketedPasteMode: boolean;
  applicationCursorKeysMode: boolean;
}

/** 화면이 아직 서기 전(= `term.write` 콜백 전)의 값. 이 상태에서는 입력
 *  컨트롤이 비활성이라 실제로 쓰이지 않지만, 기본값이 있어야 타입이 닫힌다. */
export const DEFAULT_MODES: TerminalModes = {
  bracketedPasteMode: false,
  applicationCursorKeysMode: false,
};
