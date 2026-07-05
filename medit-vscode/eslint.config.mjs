import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
    { ignores: ['src/generated/**', 'out/**', 'webview/dist/**', 'node_modules/**', 'src/test/webviewUtils.test.ts'] },

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
    // counterparts (S3776/S1541/S138/S134/S107). Kept at `warn` so they never fail
    // `npm run lint`; the code-quality Stop hook surfaces them scoped to changed files.
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
        rules: { ...reactHooks.configs.recommended.rules },
        languageOptions: {
            parserOptions: {
                project: './webview/tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
);
