import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'
import { workspaceImportRule } from './tools/workspace-boundaries.mjs'

export default defineConfig(
  globalIgnores(['**/dist/']),
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
    plugins: { viesma: { rules: { 'workspace-import': workspaceImportRule } } },
    rules: { 'viesma/workspace-import': 'error' },
  },
  {
    files: ['packages/{domain,game-data,physics,simulation,protocol}/src/**/*.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': ['error', { lib: 'never', path: 'never', types: 'never' }],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Inject a random source.' },
        { object: 'Date', property: 'now', message: 'Inject a clock.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0], CallExpression[callee.name="Date"]',
          message: 'Inject a clock.',
        },
        { selector: 'TSImportEqualsDeclaration', message: 'Use ESM imports.' },
      ],
    },
  }
)
