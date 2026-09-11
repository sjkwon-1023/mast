import { defineConfig } from "vite";

// 기본 Vite 설정. Tauri devUrl(tauri.conf.json)과 포트를 맞추기 위해 5174 고정 —
// spike(5173)와 동시에 띄울 수 있게 포트를 분리한다.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
