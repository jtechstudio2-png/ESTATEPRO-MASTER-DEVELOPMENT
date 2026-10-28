import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.next/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'next-env.d.ts', 'public/**', 'src/lib/api-schema.ts'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs', 'next.config.mjs', 'scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'no-restricted-syntax': [
        'error',
        {
          // UI checklist §8 and W-D9: no tokens or session data in browser storage.
          selector: "MemberExpression[object.name='sessionStorage']",
          message: 'Do not use sessionStorage; server state lives in the BFF session.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'react-aria-components', importNames: ['Link'], message: 'Use next/link (or LinkButton) for navigation.' }],
        },
      ],
    },
  },
  {
    files: ['test/**/*.{ts,tsx}', 'e2e/**/*.ts', '*.config.ts', 'scripts/*.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
