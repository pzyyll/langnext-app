// ABOUTME: Flat ESLint config for TypeScript React with Prettier integration.
// ABOUTME: Ignores build output, Tauri Rust tree, and generated route tree.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist", "src-tauri", "node_modules", "src/routeTree.gen.ts"],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
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
  eslintConfigPrettier,
);
