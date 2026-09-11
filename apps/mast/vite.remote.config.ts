import { defineConfig } from "vite";

export default defineConfig({
  root: "remote",
  base: "/remote/",
  build: {
    outDir: "../dist/remote",
    emptyOutDir: true,
    target: "es2022",
  },
});
