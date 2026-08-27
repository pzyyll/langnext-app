// ABOUTME: Vite config for the Tauri frontend (React + Tailwind + TanStack Router).
// ABOUTME: Keeps Tauri-friendly fixed port, HMR, ignores src-tauri, and wires unplugin-icons.
import path from "node:path";
import { fileURLToPath } from "node:url";

// Size ceiling for codeSplitting groups. Kept below Vite's 500 KiB warning threshold; the
// warning limit itself is never raised. See rolldown `OutputOptions.codeSplitting`.
const SPLIT_GROUP_MAX_BYTES = 450 * 1024;
// Group priority tiers: higher numbers are captured first, so the massively shared Markdown
// runtime/Shiki core split before the app-shell vendor libraries, and lazy Shiki grammars and
// themes (excluded by test below) are never pulled into a shared chunk.
const STREAMDOWN_GROUP_PRIORITY = 100;
const SHIKI_CORE_GROUP_PRIORITY = 90;
const SHELL_VENDOR_GROUP_PRIORITY = 70;
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
  build: {
    manifest: true,
    rolldownOptions: {
      checks: {
        // PLUGIN_TIMINGS is a warning-level diagnostic in this Vite 8/Rolldown invocation.
        pluginTimings: false,
      },
      output: {
        // Vite 8/Rolldown manual code splitting. `manualChunks` was removed; named groups with
        // `test`, `priority`, and `maxSize` are the current API. The Markdown runtime stays lazy:
        // `MarkdownOutput.tsx` remains a dynamic entry and the eight grammars + two themes keep
        // emitting as independent dynamic entries (excluded from the shiki-core test).
        codeSplitting: {
          groups: [
            {
              name: "streamdown",
              test: /node_modules[/\\]streamdown[/\\]/,
              priority: STREAMDOWN_GROUP_PRIORITY,
              maxSize: SPLIT_GROUP_MAX_BYTES,
              // Streamdown is a React component library; without this, the group's recursive
              // dependency capture pulls shared React runtime modules into a `streamdown-*` chunk
              // that every entry statically needs, breaking the lazy Markdown runtime seam.
              includeDependenciesRecursively: false,
            },
            {
              // Shiki runtime/core only. `langs` and `themes` stay dynamic entries so each
              // allowlisted grammar/theme remains independently lazy-loadable.
              name: "shiki-core",
              test: /node_modules[/\\]@shikijs[/\\](?!langs(?:[/\\]|$)|themes(?:[/\\]|$))/,
              priority: SHIKI_CORE_GROUP_PRIORITY,
              maxSize: SPLIT_GROUP_MAX_BYTES,
              includeDependenciesRecursively: false,
            },
            {
              // App-shell vendors that statically dominate the initial entry chunk. Targeted and
              // bounded so every emitted chunk stays under the 500 KiB warning threshold without
              // raising `chunkSizeWarningLimit` or introducing a blanket `node_modules` group.
              name: "shell-vendor",
              test: (id) =>
                /node_modules[/\\]@effect[/\\]/.test(id) ||
                /node_modules[/\\](?:react-dom|scheduler|react|effect|zod)[/\\]/.test(id),
              priority: SHELL_VENDOR_GROUP_PRIORITY,
              maxSize: SPLIT_GROUP_MAX_BYTES,
            },
          ],
        },
      },
    },
  },
  // Restrict dependency discovery to the app entry; the repo also contains Rustdoc HTML.
  optimizeDeps: {
    entries: ["index.html"],
  },
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
      // 3. ignore non-frontend trees; some contain hundreds of thousands of generated files
      ignored: ["**/src-tauri/**", "**/runtime-plugins/**/target/**", "**/.worktrees/**", "**/undefined/**"],
    },
  },
}));
