import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Secure Remote 정적 페이지 — 공개 Pages 경로(`https://sjkwon-1023.github.io/mast/`)에
// 올라가므로 base 가 `/mast/` 다. 산출물 디렉터리는 Tauri `frontendDist`(`../dist`) **밖**인
// `dist-secure-remote` 다: 이 번들은 DB·파일 I/O 가 없는 Pages 전용 자산이라 exe 에 임베드될
// 이유가 없고, `dist` 안에 두면 `tauri build` 가 통째로 실어 나른다. Pages 배포는
// `dist-secure-remote` 의 `index.html`·`assets/` 를 gh-pages 루트에 복사한다.
// @xterm/headless@6.0.0 의 package.json `module` 은 패키지에 없는 lib/xterm.mjs 를 가리켜 Vite 해석이
// 실패한다. 5.5 가 해석하던 CJS 엔트리를 직접 잡는다. ESM 파일(lib-headless/xterm-headless.mjs)은
// 라이선스 주석의 `http://` 문자열이 번들에 들어와 이 페이지의 Secure Remote 감사에 걸리므로 쓰지 않는다.
export default defineConfig({
  root: "secure-remote",
  base: "/mast/",
  resolve: {
    alias: {
      "@xterm/headless": fileURLToPath(
        new URL("./node_modules/@xterm/headless/lib-headless/xterm-headless.js", import.meta.url),
      ),
    },
  },
  build: {
    outDir: "../dist-secure-remote",
    emptyOutDir: true,
    target: "es2022",
    // 이 번들에는 동적 import 가 없어 폴리필이 필요 없다. 기본값이면 entry 에
    // modulepreload 폴리필이 인라인되어 `fetch(` 문자열이 산출물에 남는다 —
    // "Secure Remote 번들에 HTTP 요청 코드 없음"을 산출물 기준으로 검사할 수 있게 끈다.
    modulePreload: { polyfill: false },
  },
});
