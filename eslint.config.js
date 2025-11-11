const js = require('@eslint/js');
const typescript = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');
const prettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const globals = require('globals');

// Common TypeScript rules
const commonTsRules = {
  ...typescript.configs.recommended.rules,
  ...prettierConfig.rules,
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/explicit-function-return-type': 'warn',
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-require-imports': 'off',
  'no-case-declarations': 'off',
  'prettier/prettier': 'error',
};

// Common TypeScript config
const createTsConfig = (files, project, extraGlobals = {}, ruleOverrides = {}) => ({
  files,
  languageOptions: {
    parser: typescriptParser,
    parserOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      project,
    },
    globals: {
      ...globals.node,
      ...extraGlobals,
    },
  },
  plugins: {
    '@typescript-eslint': typescript,
    prettier,
  },
  rules: {
    ...commonTsRules,
    ...ruleOverrides,
  },
});

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', '**/*.d.ts'] },
  { files: ['eslint.config.js'], languageOptions: { globals: globals.node } },
  js.configs.recommended,
  createTsConfig(['src/**/*.ts'], './tsconfig.json', globals.browser, { 'no-console': 'warn' }),
  {
    files: ['tests/**/*.js'],
    languageOptions: { ecmaVersion: 2020, sourceType: 'commonjs', globals: globals.node },
    plugins: { prettier },
    rules: { ...prettierConfig.rules, 'prettier/prettier': 'error' },
  },
  createTsConfig(['tests/**/*.ts'], './tests/tsconfig.json', globals.jest, { 'no-console': 'off' }),
];
