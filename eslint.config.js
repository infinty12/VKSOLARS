import eslintPluginAstro from 'eslint-plugin-astro';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['dist/', '.astro/', 'node_modules/', '.claude/', 'playwright-report/', 'test-results/'],
  },
  ...tseslint.configs.recommended,
  ...eslintPluginAstro.configs.recommended,
];
