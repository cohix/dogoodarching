// Minimal flat config: typescript-eslint's recommended rules over the Worker
// (`src`), the SPA (`frontend/src`) and the tests (`test`), plus one project
// rule: D1 does not support `db.transaction()` (REVIEW.md C1), so any
// `.transaction(` call is an error. Use `db.batch([...])` for atomic
// multi-statement writes instead.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", ".wrangler/", "frontend/public/", "**/*.d.ts"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "frontend/src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}", "*.ts", "frontend/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression > MemberExpression.callee[property.name='transaction']",
          message:
            "D1 rejects `.transaction()` (REVIEW.md C1). Use `db.batch([...])` for atomic multi-statement writes.",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
