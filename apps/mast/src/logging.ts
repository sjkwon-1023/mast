// 프론트엔드 → 런타임 로그 파일. **꺼져 있는 것이 기본**이고, `settings.json` 의
// `"log": true` 로만 켜진다 (백엔드 계약은 `logfile.rs`).
//
// 이 층이 따로 있는 이유는 mast 의 문제 중 일부가 **WebView 안에서만** 벌어지기
// 때문이다. 2026-08-22 의 한글 IME 건 — 조합이 끝나지 않은 채 남아 이전 글자가
// 반복되고 그동안 모든 단축키가 죽었던 — 은 글루 로그가 있었어도 한 줄도 안 잡혔다.
// 그 건에서 코드만으로 확정할 수 있었던 것은 "브라우저가 조합 중이라고 믿고 있었다"
// 까지였고, `compositionend` 가 아예 안 온 것인지 왔는데 상태가 안 풀린 것인지는
// 갈리지 않았다. 여기서 남기는 두 줄이 정확히 그 갈림을 메운다.
//
// **꺼져 있을 때는 리스너를 설치조차 하지 않는다.** 설치해 두고 안에서 되돌아
// 나오게 만들면 타자 한 글자마다 핸들러가 도는 값을 치른다 — 켜지 않은 사용자가
// 그 값을 낼 이유가 없다.
//
// **내용은 남기지 않는다.** 조합 이벤트는 글자 수만 남기고 글자를 남기지 않으며,
// 단축키는 이름 있는 키(`ArrowLeft`·`Tab`)만 그대로 남기고 인쇄 가능한 한 글자는
// 가린다. 로그 파일이 사용자가 친 것의 사본이 되면 안 된다는 규율이 백엔드와 같다.

import { logLine } from "./backend";
import type { UiSettings } from "./backend";

let enabled = false;

/** 이 세션에서 프론트 로그가 켜져 있는가. */
export function isLogging(): boolean {
  return enabled;
}

/** 한 줄 남긴다 — 꺼져 있으면 no-op. 실패는 삼킨다: 로그를 남기려다 기능이 죽는
 *  것이 로그가 없는 것보다 나쁘다. */
export function log(text: string): void {
  if (!enabled) return;
  void logLine(text).catch(() => undefined);
}

/** 로그에 적을 키 이름. `ArrowLeft`·`Tab` 처럼 **이름이 두 글자 이상인** 키는 그대로
 *  두고, 인쇄 가능한 한 글자는 `(char)` 로 가린다 — 사용자가 친 글자를 파일에 남기지
 *  않으면서 "어떤 단축키가 삼켜졌나"는 그대로 읽히게 하는 선이다. */
export function describeKey(key: string): string {
  return key.length > 1 ? key : "(char)";
}

/** 조합 중이라는 이유로 삼켜진 단축키 한 줄. 수식키가 붙은 조합만 부른다 —
 *  수식키 없는 키는 애초에 단축키가 아니라 입력이다. */
export function logSwallowedShortcut(ev: KeyboardEvent): void {
  if (!enabled) return;
  log(
    `ime: shortcut dropped while composing key=${describeKey(ev.key)} ` +
      `ctrl=${ev.ctrlKey} alt=${ev.altKey} shift=${ev.shiftKey}`,
  );
}

/** 부팅 배선 — 설정이 켜져 있을 때만 조합 이벤트 추적을 설치한다.
 *
 *  capture 단계 window 리스너인 이유는 xterm 의 숨은 textarea 가 이벤트를 소비해도
 *  먼저 보기 위해서다. 조합의 시작·갱신·끝이 **각각 도착했는지**가 관찰 대상이라,
 *  중간에 누가 멈추면 관찰 자체가 무의미해진다. */
export function installFrontEndLogging(
  settings: UiSettings,
  target: EventTarget = window,
): void {
  if (settings.log !== true) return;
  enabled = true;
  log("ui: front end logging on");

  const types = ["compositionstart", "compositionupdate", "compositionend"] as const;
  for (const type of types) {
    target.addEventListener(
      type,
      (ev) => {
        const data = (ev as CompositionEvent).data ?? "";
        const tag = (ev.target as HTMLElement | null)?.tagName ?? "?";
        log(`ime: ${type} len=${data.length} target=${tag}`);
      },
      { capture: true },
    );
  }
}
