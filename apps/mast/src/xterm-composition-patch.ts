// `@xterm/xterm` 5.5.0 의 IME 조합 전송 결함을 **빌드 시점에** 한 표현식만 바꿔 고친다
// (ADR-0020). 왜 업그레이드가 아니라 패치인지, 무엇이 깨지는지는 ADR 에 있다 — 요지는
// 업스트림이 5.5.0 발행 3일 뒤 고쳤지만(`52e8a75e9f`, xterm.js #5023) 그 수정이 실린
// stable 이 major 인 6.0.0 뿐이라는 것이다.
//
// 대상은 `CompositionHelper._finalizeComposition` 의 지연 전송 분기: 새 조합이 이미
// 시작된 상태에서 textarea 값의 `[start, end)` 를 보내는데, 그 `end` 는 직전 태스크의
// compositionupdate 타이머가 넣은 값이라 메인 스레드가 바빠 키 두 개 이상이 타이머보다
// 먼저 처리되면 한 글자짜리 낡은 창을 읽는다. 업스트림 수정은 창의 끝을 "가장 새
// 조합의 start" 로 잡는다 — 그러면 전송이 뭉개져도 그 사이 커밋된 글자를 전부 싣는다.
//
// 표현식은 **정확히 한 번** 있어야 하고 아니면 빌드를 세운다. 번들이 바뀌었는데 조용히
// 넘어가면 이 결함이 소리 없이 돌아온다 — 번들 bump 뒤 이 에러가 나면 업스트림
// `CompositionHelper.ts` 를 다시 읽고 패치를 지우거나 새 표현식에 맞춘다.

import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

const XTERM_BUNDLE = /[\\/]node_modules[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.js$/;

export const STALE_WINDOW = "this._textarea.value.substring(e.start,e.end)";
export const FIXED_WINDOW =
  "this._textarea.value.substring(e.start,this._compositionPosition.start)";

export function patchXtermComposition(code: string): string {
  const parts = code.split(STALE_WINDOW);
  if (parts.length !== 2) {
    throw new Error(
      `@xterm/xterm composition patch: expected \`${STALE_WINDOW}\` exactly once in ` +
        `lib/xterm.js, found ${parts.length - 1} — the bundle changed; re-read upstream ` +
        "CompositionHelper.ts (xterm.js commit 52e8a75e9f) before dropping or re-targeting this patch",
    );
  }
  return parts.join(FIXED_WINDOW);
}

/** 프로덕션 빌드는 Rollup 의 `transform` 이 node_modules 도 지나므로 그 훅으로 충분하지만,
 *  dev 서버는 의존성을 esbuild 로 미리 번들해(`optimizeDeps`) 플러그인 transform 을
 *  건너뛴다 — 그 경로에는 esbuild 쪽 onLoad 를 따로 건다. 둘 중 하나만 걸면 dev 와
 *  release 의 한글 입력이 서로 다르게 동작한다. */
export function xtermCompositionPatch(): Plugin {
  const name = "mast:xterm-composition-patch";
  return {
    name,
    enforce: "pre",
    config: () => ({
      optimizeDeps: {
        esbuildOptions: {
          plugins: [
            {
              name,
              setup(build) {
                build.onLoad({ filter: XTERM_BUNDLE }, async (args) => ({
                  contents: patchXtermComposition(await readFile(args.path, "utf8")),
                  loader: "js",
                }));
              },
            },
          ],
        },
      },
    }),
    transform(code, id) {
      if (!XTERM_BUNDLE.test(id)) return null;
      return { code: patchXtermComposition(code), map: null };
    },
  };
}
