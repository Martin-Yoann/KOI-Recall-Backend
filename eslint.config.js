import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.vercel/**',
      '.tmp-*',
      'drizzle/**',
      'openapi/**',
      'eslint.config.js',
      'scripts/**',
      // One-off scratch scripts written during a session and deleted after: they are
      // outside the type-checked project on purpose (the parser needs each file in the
      // tsconfig, or in `allowDefaultProject`), and ignoring them here is what keeps a
      // throwaway script from failing the lint gate the way it did once.
      '_*.ts',
      '_*.py',
      // Session tooling artifacts (rendered docs and their generators), not part of
      // the type-checked project.
      '.zcode/**',
      // Vercel serverless entry shim; not part of the type-checked tsconfig project.
      'api/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
