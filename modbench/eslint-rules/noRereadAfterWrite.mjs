// ADR-0015 invariant 2: a command writes a system of record and returns, and the watcher brings
// the change back. A function that makes a write re-reads no view.

/** @import { Rule, SourceCode } from 'eslint' */
/** @import { CallExpression, Node, Program } from 'estree' */

export const REREAD_AFTER_WRITE_MESSAGE =
    'A write writes its file and returns. A view changes only when the watch reads the file back: the '
    + "Instance loader's next value for the instance's files, mEdit's published rows for plugin source. "
    + 'A write path never refreshes or invalidates a view, landed or failed (ADR-0015 invariant 2).';

// Every call that writes a system of record from a view's gesture, by the name it is called under.
export const WRITES = new Set([
    'setPluginsParticipation', 'setPluginsEnabled', 'reorderPlugins', 'appendPlugin', 'onPluginCheckboxChanged',
    'createPlugin', 'track', 'createRecord', 'deleteRecords', 'copyRecords', 'editRecord',
    'keepAsMyEdit', 'absorbUpstreamUpdate',
]);

export const VIEW_REREADS = new Set([
    'invalidate', 'refresh', 'refreshFacts', 'refreshMatchingPlugins', 'refreshTree', 'fire',
]);

/** @param {CallExpression} node */
function calleeName(node) {
    const { callee } = node;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
        return callee.property.name;
    }
    return undefined;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * What a call of the function runs: its body, without the bodies of the functions it only defines.
 * @param {Node} node
 * @param {SourceCode['visitorKeys']} keys
 * @param {(node: Node) => void} visit
 */
function walkBody(node, keys, visit) {
    visit(node);
    for (const key of keys[node.type] ?? []) {
        /** @type {unknown} */
        const child = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node))[key];
        const items = Array.isArray(child) ? /** @type {unknown[]} */ (child) : [child];
        for (const item of items) {
            if (!item || typeof item !== 'object' || !('type' in item)) continue;
            const next = /** @type {Node} */ (item);
            if (!FUNCTIONS.has(next.type)) walkBody(next, keys, visit);
        }
    }
}

/** @typedef {{ writes: boolean, rereads: boolean }} Effects */

/**
 * The module's own top-level functions by name, one level deep: a helper's helpers are not followed.
 * @param {Program} program
 * @param {SourceCode['visitorKeys']} keys
 * @returns {Map<string, Effects>}
 */
function moduleHelpers(program, keys) {
    /** @type {Map<string, Effects>} */
    const helpers = new Map();
    /** @param {string} name @param {Node} fn */
    const add = (name, fn) => {
        /** @type {Effects} */
        const effects = { writes: false, rereads: false };
        walkBody(fn, keys, (node) => {
            if (node.type !== 'CallExpression') return;
            const called = calleeName(node);
            if (called === undefined) return;
            if (WRITES.has(called)) effects.writes = true;
            if (VIEW_REREADS.has(called)) effects.rereads = true;
        });
        helpers.set(name, effects);
    };
    for (const statement of program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (declaration?.type === 'FunctionDeclaration') add(declaration.id.name, declaration);
        if (declaration?.type !== 'VariableDeclaration') continue;
        for (const declarator of declaration.declarations) {
            const { id, init } = declarator;
            if (id.type !== 'Identifier' || !init) continue;
            if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') add(id.name, init);
        }
    }
    return helpers;
}

/** @typedef {{ writes: boolean, rereads: CallExpression[] }} Frame */

/** @type {Rule.RuleModule} */
export const noRereadAfterWrite = {
    meta: {
        type: 'problem',
        docs: {
            description: 'A function that makes a write never re-reads a view (ADR-0015 invariant 2).',
        },
        schema: [],
        messages: { reread: REREAD_AFTER_WRITE_MESSAGE },
    },
    create(context) {
        /** @type {Frame[]} */
        const frames = [];
        /** @type {Set<CallExpression>} */
        const reported = new Set();
        /** @type {Map<string, Effects>} */
        let helpers = new Map();

        const enter = () => { frames.push({ writes: false, rereads: [] }); };
        const exit = () => {
            const frame = frames.pop();
            if (!frame?.writes) return;
            for (const node of frame.rereads) {
                if (reported.has(node)) continue;
                reported.add(node);
                context.report({ node, messageId: 'reread' });
            }
        };

        return {
            Program(node) { helpers = moduleHelpers(node, context.sourceCode.visitorKeys); },
            FunctionDeclaration: enter,
            FunctionExpression: enter,
            ArrowFunctionExpression: enter,
            'FunctionDeclaration:exit': exit,
            'FunctionExpression:exit': exit,
            'ArrowFunctionExpression:exit': exit,
            CallExpression(node) {
                const name = calleeName(node);
                if (name === undefined) return;
                const helper = node.callee.type === 'Identifier' ? helpers.get(name) : undefined;
                // A call inside a nested function is in every enclosing function's body too.
                if (WRITES.has(name) || helper?.writes) for (const frame of frames) frame.writes = true;
                if (VIEW_REREADS.has(name) || helper?.rereads) for (const frame of frames) frame.rereads.push(node);
            },
        };
    },
};
