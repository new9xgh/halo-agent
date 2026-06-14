// Flat config (eslint 9+). Minimal baseline for a TS monorepo that was never
// linted — start lenient, tighten later. Type-aware rules are intentionally
// OFF (they need per-package tsconfig wiring and are slow); this is a syntax +
// obvious-mistake pass only.
//
// Scope: server (backend) + cli (Ink/React TUI). admin is a Next.js front-end
// whose react-hooks lint is a separate, larger effort (~100 findings) — not yet
// bundled into the build gate.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Lenient rules shared by every linted package — calibrated to this codebase's
// deliberate idioms (see each comment for the why).
const baseRules = {
  // Unused vars: warn, and allow `_`-prefixed args (common intentional-skip idiom).
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  // This codebase uses a handful of `any` at external-lib boundaries — don't fail on it.
  '@typescript-eslint/no-explicit-any': 'off',
  // console is the deliberate logging mechanism here (intercepted by logger.ts).
  'no-console': 'off',
  // This codebase deliberately uses empty catch to swallow non-critical errors
  // (file-not-found, best-effort cleanup). Allow empty catch, still flag other
  // empty blocks (empty if/for/while are real mistakes).
  'no-empty': ['error', { allowEmptyCatch: true }],
  // eslint 10 promotes preserve-caught-error to recommended. Attaching a `cause`
  // to rethrown errors is good practice but not worth rewriting existing catch
  // blocks for — downgrade to off.
  'preserve-caught-error': 'off',
  // Conflicts with the TS idiom `let x = ''` + `try { x = ... } catch { fallback }`:
  // the initializer is required (TS errors "used before assigned" otherwise),
  // so the rule's "useless initial value" verdict is a false positive here.
  'no-useless-assignment': 'off',
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-pub/**', '**/node_modules/**', '**/*.cjs', '**/*.mjs'],
  },
  // server: pure backend, no React.
  {
    files: ['packages/server/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: baseRules,
  },
  // cli: Ink/React TUI. Base rules on all source.
  {
    files: ['packages/cli/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: baseRules,
  },
  // react-hooks rules ONLY on .tsx (real component files). Pure-logic .ts (e.g.
  // setup-prompts.ts, whose `useRichPrompts()` is a TTY check, not a Hook) must
  // not be judged by Hook rules.
  {
    files: ['packages/cli/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Most flagged sites are benign derived-state corrections (clamp a cursor
      // when its list shrinks; follow-the-bottom on a growing log) — all guarded
      // by an `if`, so no render loop. Keep as a hint, don't fail the gate.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
)
