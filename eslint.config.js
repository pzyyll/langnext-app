// ABOUTME: Flat ESLint config for TypeScript React with Prettier integration.
// ABOUTME: Ignores build output, Tauri Rust tree, and generated route tree.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";

export default defineConfig([
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
			"react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
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
	eslintConfigPrettier,
]);
