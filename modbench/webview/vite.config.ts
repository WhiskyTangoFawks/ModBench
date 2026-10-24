import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { WEBVIEW_SCRIPTS, WEBVIEW_STYLESHEET } from "../src/wire/webviewPages";

const entryOf = (script: string) => script.replace(/\.js$/, "");
const HOST_ASSETS = [WEBVIEW_STYLESHEET, ...Object.values(WEBVIEW_SCRIPTS)];

const hostsFindTheirAssets = (): Plugin => ({
  name: "hosts-find-their-assets",
  enforce: "post",
  generateBundle(_, bundle) {
    const missing = HOST_ASSETS.filter((name) => !(`assets/${name}` in bundle));
    if (missing.length > 0) this.error(`The hosts link assets the build did not emit: ${missing.join(", ")}`);
  },
});

export default defineConfig({
  plugins: [react(), hostsFindTheirAssets()],
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
        [entryOf(WEBVIEW_SCRIPTS.RECORD_PANEL)]: resolve(__dirname, "src/index.html"),
        [entryOf(WEBVIEW_SCRIPTS.CONFLICT_TABLE)]: resolve(__dirname, "src/conflicts.html"),
        [entryOf(WEBVIEW_SCRIPTS.FOMOD)]: resolve(__dirname, "src/fomod.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        // Vite 5 names the bundled stylesheet style.css.
        assetFileNames: ({ name }) => (name === "style.css" ? `assets/${WEBVIEW_STYLESHEET}` : "assets/[name][extname]"),
      },
    },
  },
});
