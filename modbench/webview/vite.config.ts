import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { WEBVIEW_STYLESHEET } from "../src/drivingLib/webviewStylesheet";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src"),
  // The panel loads its assets from a webview resource URI, so a URL in its CSS resolves beside
  // the file rather than from a server root.
  base: "./",
  build: {
    outDir: resolve(__dirname, "../out/webview"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        conflicts: resolve(__dirname, "src/conflicts.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: ({ name }) => (name === "style.css" ? `assets/${WEBVIEW_STYLESHEET}` : "assets/[name][extname]"),
      },
    },
  },
});
