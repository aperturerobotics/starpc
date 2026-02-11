import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import prettier from 'eslint-config-prettier'
import unusedImports from 'eslint-plugin-unused-imports'

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'vendor/**',
      'build/**',
      '.tools/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.d.ts',
      '**/*.pb.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs['flat/recommended'],
  {
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
]
