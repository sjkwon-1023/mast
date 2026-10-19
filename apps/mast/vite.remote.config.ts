import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// headless 6.0 의 `module` 필드 해석을 건너뛰고 CJS 엔트리를 쓴다 — 이유는 vite.secure-remote.config.ts 참조.
export default defineConfig({
  root: "remote",
  base: "/remote/",
  resolve: {
    alias: {
      "@xterm/headless": fileURLToPath(
        new URL("./node_modules/@xterm/headless/lib-headless/xterm-headless.js", import.meta.url),
      ),
    },
  },
  build: {
    outDir: "../dist/remote",
    emptyOutDir: true,
    target: "es2022",
  },
});
