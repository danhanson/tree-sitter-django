import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  eslintConfigPrettier, // Disable ESLint rules that conflict with Prettier
  globalIgnores([
    // Default ignores of eslint-config-next:
    "out/**",
    "build/**",
  ]),
]);

export default eslintConfig;
