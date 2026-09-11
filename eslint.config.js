import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", ".vercel/**"],
  },
  ...tseslint.configs.recommended,
);
