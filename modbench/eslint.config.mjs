import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import { noGestureResultUse } from './eslint-rules/noGestureResultUse.mjs';
import { noLeadingMEdit } from './eslint-rules/noLeadingMEdit.mjs';
import { noRereadAfterWrite } from './eslint-rules/noRereadAfterWrite.mjs';
import { BOXES, DRIVING_BOXES } from './eslint-rules/boxes.mjs';
import { ACTIVATION_DECIDES_MESSAGE, ACTIVATION_DECIDES_SELECTORS } from './eslint-rules/activationDecides.mjs';

// The message states ADR-0019's rule in full, because a developer who breaks it meets the rule only there.
const SURFACING_GOES_THROUGH_THE_REPORTER =
    'Surfacing goes through an injected reporter, never raw window calls in business logic (ADR-0019).';

// One object for every block that enables a rule from it: ESLint refuses a plugin name
// redefined by a second, different object.
const local = {
    rules: {
        'no-gesture-result-use': noGestureResultUse,
        'no-leading-medit': noLeadingMEdit,
        'no-reread-after-write': noRereadAfterWrite,
    },
};

const MESSAGE_API = /^show(Information|Warning|Error)Message$/;

// Every way to name one: a dotted member, a bracketed member, a destructured property.
const MESSAGE_API_SITES = [
    `MemberExpression[property.name=${MESSAGE_API}]`,
    `MemberExpression[computed=true][property.value=${MESSAGE_API}]`,
    `ObjectPattern > Property[key.name=${MESSAGE_API}]`,
];

const PATHLESS_BOXES = ['toolbox', 'mods', 'plugins', 'downloads', 'editor', 'drivingLib', 'textDocuments', 'instanceLoader', 'sourceLanguage'];
const PACKAGE_BOXES = ['client', 'sourceLanguage', 'agent'];
const NOT_PRODUCTION = ['**/*.test.ts', '**/test/**'];

const FS_IMPORT = {
    group: ['node:fs', 'node:fs/*', 'fs', 'fs/*'],
    message: 'The Instance adapter is the one reader and writer of the instance; every other box reaches a file through it.',
};
const PATH_IMPORT = {
    group: ['node:path', 'node:path/*', 'path', 'path/*'],
    message: 'A view or the Instance loader never builds a path: the Instance adapter answers the instance\'s, and a view takes it from the instance value, or from the box that owns it, injected at the composition root when the view does not reference that box.',
};
const PACKAGE_IMPORT = {
    regex: '^(?![.]|node:|vscode$)',
    message: 'Only the mEdit client, the Source language, the content digest (xxhash-wasm), the FOMOD installer (its engine) and the Wabbajack publisher (jsonc-parser) import a package.',
};
const DIGEST_PACKAGE_IMPORT = {
    regex: '^(?![.]|node:|vscode$|xxhash-wasm$)',
    message: 'The content digest imports one package: the xxHash mEdit\'s manifest is hashed with.',
};
const FOMOD_ENGINE_PACKAGE_IMPORT = {
    regex: '^(?![.]|node:|vscode$|@nexusmods/fomod-installer-native$)',
    message: 'The FOMOD installer imports one package: the engine it hides.',
};
const JSONC_PACKAGE_IMPORT = {
    regex: '^(?![.]|node:|vscode$|jsonc-parser$)',
    message: 'The Wabbajack publisher imports one package: the parser that reads its settings as Wabbajack does.',
};
const adapterInternalsImport = (constructs) => ({
    regex: `^(\\.{1,2}/)+instanceAdapter(/(?!(instanceAdapter${constructs ? '|openInstance' : ''})$).*)?$`,
    message: constructs
        ? 'The Instance adapter is reached through its interface and its construction.'
        : 'The Instance adapter is reached through its interface alone; only the composition root constructs it.',
});
const CLIENT_IMPORT = {
    regex: '^(\\.{1,2}/)+client(/.*)?$',
    message: 'The mEdit client is Editing\'s seam: Mod Management never reaches mEdit.',
};
const CLIENT_SEAM_IMPORT = {
    group: ['**/generated', '**/generated/**'],
    message: 'The generated client is the mEdit client box\'s: a type reaches the rest through src/wire.',
};
const HTTP_PACKAGES = [
    { name: 'openapi-fetch', message: 'Only the mEdit client box speaks HTTP to the backend.' },
    { name: 'undici', message: 'Only the mEdit client box speaks HTTP to the backend.' },
];
// `default` and `promises` are the whole module under another name.
const BYTE_READS = ['default', 'promises', 'open', 'openSync', 'openAsBlob', 'createReadStream', 'read', 'readSync', 'readv', 'readvSync'];
const BYTE_READ_PATHS = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].map((name) => ({
    name,
    importNames: BYTE_READS,
    message: 'The extension interprets no plugin binary (ADR-0004): the byte-level reads are the Instance adapter\'s content digest and the Game folder\'s read of a program\'s version.',
}));
const VSCODE_BOXES = [...DRIVING_BOXES, 'textDocuments'];
const VSCODE_IMPORT = { name: 'vscode', message: 'Only a view takes VS Code types, the Instance adapter\'s watch, and Text documents.' };
const REPORTER_IMPORT = {
    group: ['**/reporter'],
    message: 'The Instance leaves a read failure in its value for a subscriber to render; it raises no notification.',
};

/** @param {{ vscode: boolean, packages: boolean, path: boolean, client?: boolean, inAdapter?: boolean, constructs?: boolean, extra?: object[], clientSeam?: boolean, byteReads?: boolean }} where */
function restrictedImports({ vscode, packages, path, client = false, inAdapter = false, constructs = false, extra = [], clientSeam = true, byteReads = true }) {
    return ['error', {
        paths: [
            ...(vscode ? [VSCODE_IMPORT] : []),
            ...(clientSeam ? HTTP_PACKAGES : []),
            ...(byteReads ? BYTE_READ_PATHS : []),
        ],
        patterns: [
            ...(clientSeam ? [CLIENT_SEAM_IMPORT] : []),
            ...(inAdapter ? [] : [FS_IMPORT, adapterInternalsImport(constructs)]),
            ...(path ? [PATH_IMPORT] : []), ...(packages ? [PACKAGE_IMPORT] : []), ...(client ? [CLIENT_IMPORT] : []), ...extra,
        ],
    }];
}

// A view fires the commands the root bound to the Instance adapter; it takes only types from the core box.
/** @type {Record<string, string[]>} */
const BOUND_COMMAND_BOXES = {
    mods: ['modCommands/modCommands', 'modCommands/install'],
    downloads: ['downloadedFileCommands/downloads'],
    toolbox: ['instanceCommands/instanceCommands', 'sourceCommands/modlistRepositoryCommands'],
    plugins: ['pluginCommands/plugins', 'pluginCommands/renamePlugin', 'sourceCommands/sourceCommands'],
};
/** Mods reaches the Instance adapter for the installation file extensions install extracts, and for the
 *  file reads open-conflicts draws it asking for. */
/** @type {Record<string, string[]>} */
const ADAPTER_NAMES_A_VIEW_MAY_IMPORT = {
    mods: ['INSTALLATION_FILE_EXTENSIONS', 'FileRead', 'FileStamp', 'HashedFile', 'InstanceAdapter'],
};
/** @param {string} view */
const boundCommandImports = (view) => ['error', {
    patterns: [
        ...BOUND_COMMAND_BOXES[view].map((core) => ({
            group: [`**/${core}`],
            allowTypeImports: true,
            message: 'The root binds the core box\'s commands to the Instance adapter; the view receives them.',
        })),
        {
            group: ['**/instanceAdapter/**'],
            ...(ADAPTER_NAMES_A_VIEW_MAY_IMPORT[view] ? { allowImportNames: ADAPTER_NAMES_A_VIEW_MAY_IMPORT[view] } : {}),
            message: 'A view holds bound commands, and Mods reaches the Instance adapter for nothing but the installation file extensions and the file reads of a conflict table.',
        },
    ],
}];

const SYNTAX = {
    message: MESSAGE_API_SITES.map((selector) => ({ selector, message: SURFACING_GOES_THROUGH_THE_REPORTER })),
    watcher: ['CallExpression[callee.name=/^create\\w*Watcher$/]', 'CallExpression[callee.property.name=/^create\\w*Watcher$/]']
        .map((selector) => ({ selector, message: 'Every watcher on the instance is created inside the Instance adapter\'s watch.' })),
    dynamicImport: [{ selector: 'ImportExpression', message: 'A dynamic import() evades no-restricted-imports; import at the top of the file.' }],
    typeImport: [{ selector: 'TSImportType', message: 'A type is imported by an import declaration, which no-restricted-imports checks; `import(\'x\')` in a type position evades it.' }],
    hostFs: ['MemberExpression[object.property.name=\'workspace\'][property.name=\'fs\']', 'MemberExpression[object.name=\'workspace\'][property.name=\'fs\']']
        .map((selector) => ({ selector, message: 'A view reads no file: the host file system is the Instance adapter\'s.' })),
    editField: ['MemberExpression[object.name=\'WEBVIEW_TO_EXTENSION\'][property.name=\'EDIT_FIELD\']', 'MemberExpression[object.name=\'WEBVIEW_TO_EXTENSION\'][computed=true][property.value=\'EDIT_FIELD\']']
        .map((selector) => ({ selector, message: 'The record editor writes through one message from one module: the native bridge posts EDIT_FIELD.' })),
    receiveLoop: ['CallExpression[callee.property.name=\'addEventListener\'][arguments.0.value=\'message\']', 'AssignmentExpression[left.property.name=\'onmessage\']']
        .map((selector) => ({ selector, message: 'The page keeps one receive loop: the native bridge listens to the host, and a component subscribes through its listen.' })),
    activation: ACTIVATION_DECIDES_SELECTORS.map((selector) => ({ selector, message: ACTIVATION_DECIDES_MESSAGE })),
};
/** @type {(keyof typeof SYNTAX)[]} */
const EVERYWHERE_IN_SRC = ['message', 'watcher', 'typeImport', 'dynamicImport'];
/** @param {(keyof typeof SYNTAX)[]} concerns */
const restrictedSyntax = (concerns) => ['error', ...concerns.flatMap((concern) => SYNTAX[concern])];
/** @param {(keyof typeof SYNTAX)[]} exempt */
const everywhereBut = (...exempt) => EVERYWHERE_IN_SRC.filter((concern) => !exempt.includes(concern));

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

    // messages.ts casts a message once per direction, after checking its type: both ends compile
    // from the same types in the same .vsix. Pinned by unsafeTypeAssertionAllowlist.test.ts.
    {
        files: ['src/wire/columnKey.ts', 'src/wire/messages.ts'],
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


    // What a box may import beyond its reference list, which the build holds. A later block
    // replaces an earlier one's options, so each file's whole list is built from the pieces above.
    ...BOXES.map((box) => ({
        files: [`src/${box}/**/*.ts`],
        ignores: NOT_PRODUCTION,
        rules: {
            'no-restricted-imports': restrictedImports({
                vscode: !VSCODE_BOXES.includes(box),
                packages: !PACKAGE_BOXES.includes(box),
                path: PATHLESS_BOXES.includes(box),
                client: box === 'toolbox',
                inAdapter: box === 'instanceAdapter',
                clientSeam: box !== 'client',
            }),
        },
    })),
    ...Object.keys(BOUND_COMMAND_BOXES).map((view) => ({
        files: [`src/${view}/**/*.ts`],
        ignores: NOT_PRODUCTION,
        rules: { '@typescript-eslint/no-restricted-imports': boundCommandImports(view) },
    })),
    // No test reads a plugin's bytes either (ADR-0004).
    {
        files: ['src/**/*.test.ts', 'src/test/**/*.ts', 'src/*/test/**/*.ts'],
        rules: { 'no-restricted-imports': ['error', { paths: BYTE_READ_PATHS }] },
    },
    ...['messages', 'modByFolder', 'pluginAddress', 'wireContractChecks'].map((name) => ({
        files: [`src/wire/${name}.ts`],
        rules: { 'no-restricted-imports': restrictedImports({ vscode: true, packages: true, path: false, clientSeam: false }) },
    })),
    {
        files: ['src/instanceAdapter/downloadedFileContents/contentDigest.ts'],
        rules: {
            'no-restricted-imports': restrictedImports({
                vscode: true, packages: false, path: false, inAdapter: true, byteReads: false, extra: [DIGEST_PACKAGE_IMPORT],
            }),
        },
    },
    {
        files: ['src/instanceAdapter/gameFolder/versionResource.ts'],
        rules: {
            'no-restricted-imports': restrictedImports({ vscode: true, packages: false, path: false, inAdapter: true, byteReads: false }),
        },
    },
    {
        files: ['src/instanceAdapter/fomodInstaller/*.ts'],
        ignores: NOT_PRODUCTION,
        rules: {
            'no-restricted-imports': restrictedImports({
                vscode: true, packages: false, path: false, inAdapter: true, extra: [FOMOD_ENGINE_PACKAGE_IMPORT],
            }),
        },
    },
    {
        files: ['src/instanceAdapter/wabbajack/*.ts'],
        ignores: NOT_PRODUCTION,
        rules: {
            'no-restricted-imports': restrictedImports({
                vscode: true, packages: false, path: false, inAdapter: true, extra: [JSONC_PACKAGE_IMPORT],
            }),
        },
    },
    {
        files: ['src/instanceLoader/instance.ts'],
        rules: {
            'no-restricted-imports': restrictedImports({ vscode: true, packages: true, path: true, extra: [REPORTER_IMPORT] }),
        },
    },
    {
        files: ['src/instanceAdapter/watchFiles.ts'],
        rules: {
            'no-restricted-imports': restrictedImports({ vscode: false, packages: true, path: false, inAdapter: true }),
        },
    },
    {
        files: ['src/*.ts'],
        ignores: NOT_PRODUCTION,
        rules: {
            'no-restricted-imports': restrictedImports({ vscode: false, packages: false, path: false }),
        },
    },
    {
        files: ['src/extension.ts'],
        rules: {
            'no-restricted-imports': restrictedImports({ vscode: false, packages: false, path: false, constructs: true }),
        },
    },

    // Every backend call goes through the generated client, so the wire shape stays typed.
    {
        files: ['src/**/*.ts', 'webview/src/**/*.{ts,tsx}'],
        ignores: ['src/nexus/**'],
        rules: {
            'no-restricted-globals': ['error', { name: 'fetch', message: 'Backend HTTP goes through the mEdit client.' }],
        },
    },

    {
        files: ['webview/src/**/*.{ts,tsx}'],
        ignores: ['webview/src/**/*.test.{ts,tsx}', 'webview/src/test/**', 'webview/src/nativeBridge.ts'],
        rules: { 'no-restricted-syntax': restrictedSyntax(['message', 'editField', 'receiveLoop']) },
    },
    {
        files: ['webview/src/ConflictTable.tsx'],
        rules: { 'no-restricted-syntax': restrictedSyntax(['message', 'editField']) },
    },
    {
        files: ['webview/src/nativeBridge.ts'],
        rules: { 'no-restricted-syntax': restrictedSyntax(['message']) },
    },
    {
        files: ['src/**/*.ts'],
        ignores: NOT_PRODUCTION,
        rules: { 'no-restricted-syntax': restrictedSyntax(EVERYWHERE_IN_SRC) },
    },
    {
        files: ['src/*/test/**/*.ts'],
        ignores: ['**/*.test.ts'],
        rules: { 'no-restricted-syntax': restrictedSyntax(['message']) },
    },
    {
        files: ['src/instanceAdapter/watchFiles.ts'],
        rules: { 'no-restricted-syntax': restrictedSyntax(everywhereBut('watcher')) },
    },
    {
        files: ['src/downloads/**/*.ts', 'src/drivingLib/**/*.ts', 'src/editor/**/*.ts'],
        ignores: NOT_PRODUCTION,
        rules: { 'no-restricted-syntax': restrictedSyntax([...EVERYWHERE_IN_SRC, 'hostFs']) },
    },
    {
        files: ['src/drivingLib/reporter.ts'],
        rules: { 'no-restricted-syntax': restrictedSyntax([...everywhereBut('message'), 'hostFs']) },
    },
    // The dialog is the one root file that surfaces to the user.
    {
        files: ['src/*.ts'],
        rules: { 'no-restricted-syntax': restrictedSyntax([...EVERYWHERE_IN_SRC, 'activation']) },
    },
    {
        files: ['src/dialog.ts'],
        rules: { 'no-restricted-syntax': restrictedSyntax([...everywhereBut('message'), 'activation']) },
    },

    // commands.md, "An entry point fires a gesture. A gesture does not fire another.": the only
    // place `vscode.commands.executeCommand('modbench.…')` appears is `src/`, entry-point wiring.
    {
        files: ['src/**/*.ts'],
        ignores: ['src/agent/**'], // agent.md, Reporting, story 3: the agent gets each gesture's outcome.
        plugins: { local },
        rules: {
            'local/no-gesture-result-use': 'error',
        },
    },

    // ADR-0015. Tests are out of scope: a test drives a write and then the watch's own re-read.
    {
        files: ['src/**/*.ts'],
        ignores: ['src/**/*.test.ts', 'src/test/**'],
        plugins: { local },
        rules: {
            'local/no-reread-after-write': 'error',
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
                    './src/loadOrderFileCodec/tsconfig.json',
                    './src/tables/tsconfig.json',
                    './src/wire/tsconfig.json',
                    './src/ports/tsconfig.json',
                    './src/instanceAdapter/tsconfig.json',
                    './src/coreLib/tsconfig.json',
                    './src/instanceLoader/tsconfig.json',
                    './src/modCommands/tsconfig.json',
                    './src/pluginCommands/tsconfig.json',
                    './src/instanceCommands/tsconfig.json',
                    './src/sourceCommands/tsconfig.json',
                    './src/downloadedFileCommands/tsconfig.json',
                    './src/client/tsconfig.json',
                    './src/drivingLib/tsconfig.json',
                    './src/textDocuments/tsconfig.json',
                    './src/mods/tsconfig.json',
                    './src/downloads/tsconfig.json',
                    './src/plugins/tsconfig.json',
                    './src/editor/tsconfig.json',
                    './src/toolbox/tsconfig.json',
                    './src/sourceLanguage/tsconfig.json',
                    './src/agent/tsconfig.json',
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
