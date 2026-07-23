// ABOUTME: Flat ESLint config for TypeScript React with Prettier integration.
// ABOUTME: Ignores build output, Tauri Rust tree, and generated route tree.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: ["dist", "src-tauri", "node_modules", "src/routeTree.gen.ts", ".agents", ".worktrees"],
  },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      // Full Tailwind suite: stylistic (warn) + correctness (error).
      betterTailwindcss.configs.recommended,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    settings: {
      "better-tailwindcss": {
        // Tailwind v4 CSS-first entry (same as tailwindCSS.experimental.configFile).
        entryPoint: "src/styles.css",
        // Project CSS component classes (e.g. shadow-frame, loading-dots).
        detectComponentClasses: true,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Match .prettierrc printWidth; loose avoids endless Prettier↔ESLint wrap fights.
      "better-tailwindcss/enforce-consistent-line-wrapping": [
        "warn",
        {
          printWidth: 120,
          strictness: "loose",
        },
      ],
      // Plain CSS helpers in src/styles.css (not @utility / @layer components).
      "better-tailwindcss/no-unknown-classes": [
        "error",
        {
          ignore: [
            "^loading-dots$",
            "^markdown-output$",
            "^root$",
            "^no-app-drag$",
            "^shadow-frame$",
            "^page-transition$",
            "^border-beam$",
          ],
        },
      ],
    },
  },
  {
    files: ["src/routes/**/*.{ts,tsx}"],
    rules: {
      // TanStack file routes export `Route` alongside page components.
      "react-refresh/only-export-components": "off",
    },
  },
  // Type-aware: surface @deprecated usages (TS hint 6385) as lint warnings.
  // Test files are excluded (not in any tsconfig) to keep project-service happy.
  {
    files: ["src/**/*.{ts,tsx}", "vite.config.ts"],
    ignores: ["**/*.test.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "warn",
    },
  },
  // Keep after Tailwind rules so Prettier still owns pure formatting conflicts.
  eslintConfigPrettier,
]);
