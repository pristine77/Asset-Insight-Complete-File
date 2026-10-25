const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      '**/node_modules/**',
      '.expo/**',
      'dist/**',
      'web-build/**',
      'coverage/**',
      '**/android/build/**',
      '**/android/.gradle/**',
      '**/android/.kotlin/**',
      '**/android/.cxx/**',
      'android/app/build/**',
      'android/app/.cxx/**',
      'ios/build/**',
      'ios/Pods/**',
    ],
  },
  {
    rules: {
      'react/display-name': 'off',
    },
  },
]);
