// ABOUTME: Vite config for the Tauri frontend (React + Tailwind + TanStack Router).
// ABOUTME: Keeps Tauri-friendly fixed port, HMR, ignores src-tauri, and wires unplugin-icons.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import Icons from "unplugin-icons/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import * as cheerio from "cheerio";

const host = process.env.TAURI_DEV_HOST;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      quoteStyle: "double",
    }),
    react(),
    tailwindcss(),
    Icons({
      autoInstall: true,
      compiler: "jsx",
      jsx: "react",
      customCollections: {
        svgs: FileSystemIconLoader(path.resolve(rootDir, "src/assets/icons"), (svg) => {
          // Normalize size; keep multi-color brand fills, theme monochrome icons.
          const $ = cheerio.load(svg, { xmlMode: true });
          const $svg = $("svg");
          $svg.removeAttr("width");
          $svg.removeAttr("height");
          $svg.removeAttr("style");

          const hasExplicitChildFills = $svg
            .find("[fill]")
            .toArray()
            .some((el) => {
              const fill = $(el).attr("fill");
              return Boolean(fill && fill !== "none" && fill !== "currentColor");
            });

          if (hasExplicitChildFills) {
            // Brand / multi-color icons keep path fills as authored.
            $svg.removeAttr("fill");
          } else {
            $svg.attr("fill", "currentColor");
          }

          return $.xml($svg);
        }),
      },
      iconCustomizer(collection, _icon, props) {
        if (collection === "svgs") {
          props.width = "1.5em";
          props.height = "1.5em";
        }
      },
    }),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
