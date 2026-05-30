import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src"),
  build: {
    outDir: resolve(__dirname, "../out/webview"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/index.html"),
      output: {
        entryFileNames: "assets/main.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
