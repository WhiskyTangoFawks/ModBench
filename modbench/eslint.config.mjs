import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import { noGestureResultUse } from './eslint-rules/noGestureResultUse.mjs';
import { noLeadingMEdit } from './eslint-rules/noLeadingMEdit.mjs';

// ADR-0019 invariant 3, verbatim, because a lint message is the only place a developer meets it.
const SURFACING_GOES_THROUGH_THE_REPORTER =
    'Surfacing goes through an injected reporter, never raw window calls in business logic (ADR-0019 invariant 3).';

// One object for every block that enables a rule from it: ESLint refuses a plugin name
// redefined by a second, different object.
const local = {
    rules: {
        'no-gesture-result-use': noGestureResultUse,
        'no-leading-medit': noLeadingMEdit,
    },
};

const MESSAGE_API = /^show(Information|Warning|Error)Message$/;

// Every way to name one: a dotted member, a bracketed member, a destructured property.
const MESSAGE_API_SITES = [
    `MemberExpression[property.name=${MESSAGE_API}]`,
    `MemberExpression[computed=true][property.value=${MESSAGE_API}]`,
    `ObjectPattern > Property[key.name=${MESSAGE_API}]`,
];

const VIEW_BOXES = ['toolbox', 'mods', 'plugins', 'downloads', 'editor'];

export default defineConfig(
    { ignores: ['src/wire/generated/**', 'out/**', 'webview/dist/**', 'node_modules/**'] },

    eslint.configs.recommended,
    tseslint.configs.strictTypeChecked,

    // Standard convention: _-prefixed params are intentionally unused
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            // The generated schema reports nullability honestly, so a `??` or `?.` on a wire
            // field the schema calls non-nullable is a bug, not defensive coding.
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/switch-exhaustiveness-check': ['error', { requireDefaultForNonUnion: true }],
            // A void-returning callback passed by shorthand arrow (`onClick={() => doThing()}`) is
            // idiomatic React and VS Code API usage here, not a confusing expression.
            '@typescript-eslint/no-confusing-void-expression': 'off',
            // Interpolating a number, enum or nullish value into a log or error message is the
            // normal case in this codebase, not a stringification bug.
            '@typescript-eslint/restrict-template-expressions': 'off',
        },
    },

    // A narrowing cast is the fastest way past a type error, and the easiest habit to copy —
    // in a test as much as in production. Off only in the two allowlists below.
    {
        files: ['src/**/*.ts', 'webview/src/**/*.{ts,tsx}'],
        rules: {
            '@typescript-eslint/no-unsafe-type-assertion': 'error',
        },
    },

    // `!` asserts an invariant the checker can't see instead of showing it one — the present()
    // helper (src/present.ts) or a restructuring does that instead.
    {
        files: ['src/**/*.ts', 'webview/src/**/*.{ts,tsx}'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'error',
        },
    },

    // Each file below holds exactly one function, and that function is its file's only cast —
    // named the way the errno reader is, not a suppression widened to a whole client or module.
    // Pinned by unsafeTypeAssertionAllowlist.test.ts.
    {
        files: ['webview/src/columnKey.ts', 'webview/src/parseCompareResult.ts'],
        rules: {
            '@typescript-eslint/no-unsafe-type-assertion': 'off',
        },
    },

    // The record document's field tree, read one dynamic member/discriminator at a time — not
    // reducible to one function each. Pinned by unsafeTypeAssertionAllowlist.test.ts.
    {
        files: [
            'webview/src/recordUtils.ts', 'webview/src/presentation.ts', 'webview/src/siblingsInUse.ts',
            'webview/src/modelValue.ts',
        ],
        rules: {
            '@typescript-eslint/no-unsafe-type-assertion': 'off',
        },
    },

    // Mod Management never calls the backend (CONTEXT.md).
    {
        files: ['src/modmanager/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: [{ group: ['**/medit/**', '**/client/**'], message: 'Mod Management never calls the backend.' }] }],
        },
    },

    // modbench/CLAUDE.md: a view takes every path from the instance value and never builds one.
    // The views are README's driving band: Toolbox, Mods, Plugins, Downloads and Editor.
    {
        files: VIEW_BOXES.map((box) => `src/${box}/**/*.ts`),
        ignores: VIEW_BOXES.map((box) => `src/${box}/test/**`),
        rules: {
            'no-restricted-imports': ['error', { patterns: [{
                group: ['node:path', 'node:path/*', 'path', 'path/*'],
                message: 'A view never builds a path: take it from the instance value, or from the box that owns it, injected at the composition root when the view does not reference that box.',
            }] }],
        },
    },

    // Every backend call goes through the generated client, so the wire shape stays typed.
    {
        files: ['src/**/*.ts', 'webview/src/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-globals': ['error', { name: 'fetch', message: 'Backend HTTP goes through the mEdit client.' }],
        },
    },

    // The reporter and the dialog are the two adapters that own a message API. Tests are out of
    // scope: the integration suite swaps the real API out to observe that a toast reached the
    // user.
    {
        files: ['src/**/*.ts', 'webview/src/**/*.{ts,tsx}'],
        ignores: [
            'src/reporter.ts', 'src/dialog.ts',
            'src/**/*.test.ts', 'src/test/**',
            'webview/src/**/*.test.{ts,tsx}', 'webview/src/test/**',
        ],
        rules: {
            'no-restricted-syntax': ['error',
                ...MESSAGE_API_SITES.map((selector) => ({ selector, message: SURFACING_GOES_THROUGH_THE_REPORTER })),
            ],
        },
    },

    // commands.md, "An entry point fires a gesture. A gesture does not fire another.": the only
    // place `vscode.commands.executeCommand('modbench.…')` appears is `src/`, entry-point wiring.
    {
        files: ['src/**/*.ts'],
        plugins: { local },
        rules: {
            'local/no-gesture-result-use': 'error',
        },
    },

    // Tests are in scope: a fixture carrying a stale message is copied into the next one.
    {
        files: ['src/**/*.ts', 'webview/src/**/*.{ts,tsx}'],
        plugins: { local },
        rules: {
            'local/no-leading-medit': 'error',
        },
    },

    // The mEdit client takes no VS Code types, so any caller (its own in-memory adapter today,
    // a tool handler or a test tomorrow) can call it without pulling in the extension host.
    {
        files: ['src/client/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'The mEdit client takes no VS Code types.' }] }],
        },
    },

    // Extension source: every project the root solution builds, because a solution file lists
    // projects and holds no source of its own.
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: [
                    './src/tsconfig.json',
                    './tsconfig.test.json',
                    './tsconfig.integration.json',
                    './src/mo2Codecs/tsconfig.json',
                    './src/tables/tsconfig.json',
                    './src/wire/tsconfig.json',
                    './src/ports/tsconfig.json',
                    './src/instanceAdapter/tsconfig.json',
                    './src/instanceLoader/tsconfig.json',
                    './src/modlist/tsconfig.json',
                    './src/pluginsCommands/tsconfig.json',
                    './src/instanceCommands/tsconfig.json',
                    './src/downloadsCommands/tsconfig.json',
                    './src/install/tsconfig.json',
                    './src/client/tsconfig.json',
                    './src/mods/tsconfig.json',
                    './src/downloads/tsconfig.json',
                    './src/plugins/tsconfig.json',
                    './src/editor/tsconfig.json',
                ],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    // The lint rules, as `tsc -b` type-checks them.
    {
        files: ['eslint-rules/*.mjs'],
        languageOptions: {
            parserOptions: {
                project: './eslint-rules/tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    // The lint config and the rules' declarations sit in no tsconfig, so typed linting reads them
    // through the project service's default project, under the base tsconfig's strict options.
    {
        files: ['eslint-rules/*.d.mts', 'eslint.config.mjs'],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['eslint-rules/*.d.mts', 'eslint.config.mjs'],
                    defaultProject: './tsconfig.base.json',
                },
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
