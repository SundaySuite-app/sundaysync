// Samme oppsett som resten av suiten (sundaystudio/eslint.config.js), tilpasset
// sync sin layout: appen i src/, Playwright-specs i e2e/ og node-skript i
// scripts/. Innført i rammeverk-runden 19.09 (D-101).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // dist/target/gen er byggeutdata; binaries/ er de hentede ffmpeg-sidecarene.
    ignores: [
      "dist",
      "src-tauri/target",
      "src-tauri/gen",
      "src-tauri/binaries",
      "playwright-report",
      "test-results",
      "coverage",
    ],
  },

  // Appen + enhetstestene (nettleser-runtime).
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Playwright-specs. Node-runtime for spec-kroppene, men `page.evaluate`/
  // `addInitScript`-callbackene kjører I siden, så begge globalsettene er
  // legitime. `any` er slått av av samme grunn som i sundayrec: å rekke inn i
  // `window` etter test-kroker (den mockede Tauri-IPC-en) er selve poenget.
  {
    files: ["e2e/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Config- og node-skript (node-runtime).
  {
    files: ["scripts/**/*.mjs", "*.{js,ts}", "*.config.{js,ts}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  prettier,
);
