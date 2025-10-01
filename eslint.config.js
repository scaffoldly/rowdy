const js = require('@eslint/js');
const typescript = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');
const prettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  // Global ignores
  {
    ignores: ['node_modules/**', 'dist/**', '**/*.d.ts'],
  },

  // ESLint config file itself
  {
    files: ['eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Base JavaScript config
  js.configs.recommended,

  // TypeScript files (excluding tests)
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      prettier,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      ...prettierConfig.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'warn',
      'no-case-declarations': 'off',
      'no-restricted-globals': [
        'error',
        {
          name: 'URL',
          message: 'Use URI class in routes.ts instead of Node.js URL interface',
        },
      ],
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            URL: 'Use URI class in routes.ts instead of Node.js URL interface',
          },
        },
      ],
      'prettier/prettier': 'error',
    },
  },

  // Test files
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tests/tsconfig.json',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      prettier,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      ...prettierConfig.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
      'no-case-declarations': 'off',
      'no-restricted-globals': [
        'error',
        {
          name: 'URL',
          message: 'Use URI class in routes.ts instead of Node.js URL interface',
        },
      ],
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            URL: 'Use URI class in routes.ts instead of Node.js URL interface',
          },
        },
      ],
      'prettier/prettier': 'error',
    },
  },
];
