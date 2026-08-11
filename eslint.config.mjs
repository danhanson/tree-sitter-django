import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  eslintConfigPrettier, // Disable ESLint rules that conflict with Prettier
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "out/**",
    "build/**",
  ]),
]);

export default eslintConfig;
