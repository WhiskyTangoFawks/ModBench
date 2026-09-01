import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
    { ignores: ['src/medit/generated/**', 'out/**', 'webview/dist/**', 'node_modules/**', 'src/medit/test/webviewUtils.test.ts'] },

    eslint.configs.recommended,
    tseslint.configs.recommendedTypeChecked,

    // Standard convention: _-prefixed params are intentionally unused
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },

    // Extension source (tsconfig.json)
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    // Complexity feedback on extension-host logic (mod-management + orchestration),
    // mirroring the backend Sonar complexity rules. Thresholds approximate their C#
    // counterparts (S3776/S1541/S138/S134/S107). Kept at `warn`, not `error`, on purpose: these
    // five are comprehension heuristics, not defect rules, so the code-quality Stop hook —
    // surfacing them on changed files between turns — is the intended feedback channel, not the
    // `lint` gate. A warning is a prompt to think, not an instruction to comply: fix a genuinely
    // tangled function, but an honestly long or branchy one can stay, with a comment saying why.
    // Never split a function whose only reason to exist would be silencing one of these.
    // `npm run lint` used to also fail on any of these via `--max-warnings 0` — that flag
    // predated the Stop hook and was never removed once the hook made it redundant; it is gone
    // now (see package.json), deliberately, and must not come back. If warnings pile up unread,
    // the fix is a separate advisory script, not restoring the flag — re-adding it recreates the
    // exact failure this file is here to prevent: functions split for no reason but the budget.
    // Not applied to webview/src (thin React presentation) or tests.
    {
        files: ['src/**/*.ts'],
        ignores: ['src/**/*.test.ts', 'src/test/**'],
        plugins: { sonarjs },
        rules: {
            'sonarjs/cognitive-complexity': ['warn', 15], // ≈ S3776
            'complexity': ['warn', 10], // ≈ S1541 cyclomatic
            'max-lines-per-function': ['warn', 80], // ≈ S138
            'max-depth': ['warn', 4], // ≈ S134
            'max-params': ['warn', 7], // ≈ S107
        },
    },

    // Test files — relax unsafe-any rules since mocks legitimately use any
    {
        files: ['src/test/**/*.ts', 'src/**/*.test.ts', 'webview/src/**/*.test.{ts,tsx}'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/unbound-method': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
        },
    },

    // Webview source (webview/tsconfig.json)
    {
        files: ['webview/src/**/*.{ts,tsx}'],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            ...reactHooks.configs.recommended.rules,
            // Pinned to `error`, overriding the plugin's own `warn` default. Removing
            // `--max-warnings 0` (see the comment above) is meant to stop the five comprehension
            // heuristics from breaking the build — it is not meant to also demote these three,
            // which the plugin ships at `warn` for unrelated reasons. `exhaustive-deps` in
            // particular catches genuine stale-closure bugs, a defect rule, not a comprehension
            // heuristic; pinning it here preserves exactly today's blocking behaviour instead of
            // silently loosening it as a side effect of the flag removal.
            'react-hooks/exhaustive-deps': 'error',
            'react-hooks/incompatible-library': 'error',
            'react-hooks/unsupported-syntax': 'error',
        },
        languageOptions: {
            parserOptions: {
                project: './webview/tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
);
