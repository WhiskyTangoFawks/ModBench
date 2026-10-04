import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src"),
  // The panel loads its assets from a webview resource URI, so a URL in its CSS resolves beside
  // the file rather than from a server root.
  base: "./",
  build: {
    outDir: resolve(__dirname, "../out/webview"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        conflicts: resolve(__dirname, "src/conflicts.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
