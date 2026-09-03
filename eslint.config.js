'use strict';

// Flat config для ESLint 9+/10 (замена .eslintrc.js).
// Окружения: CommonJS на сервере/тестах, ESM в браузерном коде и у Playwright.

const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  'no-console': 'off',
  // Пустые catch {} — намеренный приём для best-effort парсинга (см. код провайдеров)
  'no-empty': ['error', { allowEmptyCatch: true }],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    // Код на сервере и в тестах — CommonJS
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules,
  },
  {
    // Playwright-конфиг и тесты — ESM-файлы, исполняемые раннером Playwright;
    // page.evaluate() исполняется в браузере, поэтому нужны и браузерные глобалы
    files: ['playwright.config.js', 'tests/playwright/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules,
  },
  {
    // Клиентский код — ES-модули для браузера
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules,
  },
];
