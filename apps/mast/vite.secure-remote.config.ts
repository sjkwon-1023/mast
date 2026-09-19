import { defineConfig } from "vite";

// Secure Remote 정적 페이지 — 공개 Pages 경로(`https://sjkwon-1023.github.io/mast/`)에
// 올라가므로 base 가 `/mast/` 다. 산출물 디렉터리는 Tauri `frontendDist`(`../dist`) **밖**인
// `dist-secure-remote` 다: 이 번들은 DB·파일 I/O 가 없는 Pages 전용 자산이라 exe 에 임베드될
// 이유가 없고, `dist` 안에 두면 `tauri build` 가 통째로 실어 나른다. Pages 배포는
// `dist-secure-remote` 의 `index.html`·`assets/` 를 gh-pages 루트에 복사한다.
export default defineConfig({
  root: "secure-remote",
  base: "/mast/",
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
