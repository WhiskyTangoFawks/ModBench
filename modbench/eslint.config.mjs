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
            // The generated schema reports nullability honestly, so a `??` or `?.` on a wire
            // field the schema calls non-nullable is a bug, not defensive coding.
            '@typescript-eslint/no-unnecessary-condition': 'error',
        },
    },

    // Mod Management never calls the backend (root CLAUDE.md).
    {
        files: ['src/modmanager/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: [{ group: ['**/medit/**'], message: 'Mod Management never calls the backend.' }] }],
        },
    },

    // Every backend call goes through the generated client, so the wire shape stays typed.
    {
        files: ['src/**/*.ts', 'webview/src/**/*.{ts,tsx}'],
        ignores: ['src/medit/client/apiClient.ts'],
        rules: {
            'no-restricted-globals': ['error', { name: 'fetch', message: 'Backend HTTP goes through the mEdit client.' }],
        },
    },

    // ADR-0012: the mEdit client takes no VS Code types, so chat tool handlers (and its own
    // in-memory adapter) can call it directly without pulling in the extension host.
    {
        files: ['src/medit/client/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'The mEdit client takes no VS Code types (ADR-0012).' }] }],
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

    // Comprehension heuristics mirroring the backend Sonar rules, at `warn` because the
    // code-quality Stop hook is their channel, not the lint gate: an honestly long function may
    // stay. `--max-warnings 0` must not come back.
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
            // Pinned to `error` above the plugin's `warn` default: `exhaustive-deps` catches real
            // stale-closure bugs, a defect rule, not a comprehension heuristic.
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
