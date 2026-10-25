import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// The rule set the Obsidian community directory scans each release with.
export default defineConfig([
	globalIgnores(["main.js", "node_modules/", "tests/", "src/**/*.test.ts", "*.mjs", "*.mts", ".obsidian-e2e-*/"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
