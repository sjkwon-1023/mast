import { defineConfig, type Plugin } from "vite";

// KaTeX CSS 는 폰트마다 woff2·woff·ttf 를 모두 가리켜 Vite 가 세 형식을 다 번들한다.
// WebView2·WKWebView 는 첫 형식인 woff2 만 내려받으므로 나머지 참조를 지워 번들에서 뺀다.
// KaTeX 가 선언 형식을 바꾸면 조용히 세 형식으로 돌아가지 않게 빌드를 멈춘다.
function katexWoff2Only(): Plugin {
  const fallbackFonts = /,url\([^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g;
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/\/katex\/dist\/katex(?:\.min)?\.css(?:$|\?)/.test(id)) return null;
      const trimmed = code.replace(fallbackFonts, "");
      if (trimmed === code || /\.(?:woff|ttf)\)/.test(trimmed)) {
        throw new Error(`katex-woff2-only: unexpected @font-face src format in ${id}`);
      }
      return trimmed;
    },
  };
}

// Tauri devUrl(tauri.conf.json)과 포트를 맞추기 위해 5174 고정 — spike(5173)와
// 동시에 띄울 수 있게 포트를 분리한다.
export default defineConfig({
  clearScreen: false,
  plugins: [katexWoff2Only()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
