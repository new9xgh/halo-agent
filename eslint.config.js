// Flat config (eslint 9+). Minimal baseline for a TS monorepo that was never
// linted — start lenient, tighten later. Type-aware rules are intentionally
// OFF (they need per-package tsconfig wiring and are slow); this is a syntax +
// obvious-mistake pass only.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Scope: server package only. admin/cli are React/Next front-ends whose
// react-hooks lint is a separate effort (100+ findings, needs per-component
// review) — not bundled into the backend's build gate. Widen `files` when
// that work is scheduled.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.cjs', '**/*.mjs'],
  },
  {
    files: ['packages/server/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Unused vars: warn, and allow `_`-prefixed args (common intentional-skip idiom).
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // This codebase uses a handful of `any` at external-lib boundaries — don't fail on it.
      '@typescript-eslint/no-explicit-any': 'off',
      // console is the deliberate logging mechanism here (intercepted by logger.ts).
      'no-console': 'off',
      // This codebase deliberately uses empty catch to swallow non-critical
      // errors (file-not-found, best-effort cleanup). Allow empty catch, still
      // flag other empty blocks (empty if/for/while are real mistakes).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // eslint 10 promotes preserve-caught-error to recommended. Attaching a
      // `cause` to rethrown errors is good practice but not worth rewriting
      // existing catch blocks for — downgrade to off.
      'preserve-caught-error': 'off',
      // Conflicts with the TS idiom `let x = ''` + `try { x = ... } catch { fallback }`:
      // the initializer is required (TS errors "used before assigned" otherwise),
      // so the rule's "useless initial value" verdict is a false positive here.
      'no-useless-assignment': 'off',
    },
  },
)
