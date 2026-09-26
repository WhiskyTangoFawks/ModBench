// ADR-0015 invariant 2: a command writes a system of record and returns, and the watcher brings
// the change back. A function that makes a write re-reads no view.

/** @import { Rule, SourceCode } from 'eslint' */
/** @import { CallExpression, Identifier, Node, Program } from 'estree' */

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

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** @param {CallExpression} node */
function calleeName(node) {
    const { callee } = node;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
        return callee.property.name;
    }
    return undefined;
}

/**
 * @param {Node} node
 * @param {SourceCode['visitorKeys']} keys
 * @param {(node: Node) => boolean} visit whether to descend into the node's children
 */
function walk(node, keys, visit) {
    if (!visit(node)) return;
    for (const key of keys[node.type] ?? []) {
        /** @type {unknown} */
        const child = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node))[key];
        const items = Array.isArray(child) ? /** @type {unknown[]} */ (child) : [child];
        for (const item of items) {
            if (item && typeof item === 'object' && 'type' in item) walk(/** @type {Node} */ (item), keys, visit);
        }
    }
}

/** @typedef {{ writes: boolean, rereads: boolean }} Effects */

/**
 * What a call of the function runs: its body, without the bodies of the functions it only defines.
 * @param {Node} fn
 * @param {SourceCode['visitorKeys']} keys
 * @returns {Effects}
 */
function directEffects(fn, keys) {
    /** @type {Effects} */
    const effects = { writes: false, rereads: false };
    walk(fn, keys, (node) => {
        if (node !== fn && FUNCTIONS.has(node.type)) return false;
        if (node.type !== 'CallExpression') return true;
        const called = calleeName(node);
        if (called !== undefined && WRITES.has(called)) effects.writes = true;
        if (called !== undefined && VIEW_REREADS.has(called)) effects.rereads = true;
        return true;
    });
    return effects;
}

/**
 * Every function in the file a bare name can call, anywhere it is declared; two of one name share
 * their effects.
 * @param {Program} program
 * @param {SourceCode['visitorKeys']} keys
 * @returns {Map<string, Effects>}
 */
function namedFunctions(program, keys) {
    /** @type {Map<string, Effects>} */
    const helpers = new Map();
    /** @param {string} name @param {Node} fn */
    const add = (name, fn) => {
        const effects = directEffects(fn, keys);
        const known = helpers.get(name);
        helpers.set(name, {
            writes: effects.writes || (known?.writes ?? false),
            rereads: effects.rereads || (known?.rereads ?? false),
        });
    };
    walk(program, keys, (node) => {
        if (node.type === 'FunctionDeclaration') {
            // `export default function () {}` declares one with no name.
            const id = /** @type {Identifier | null} */ (node.id);
            if (id) add(id.name, node);
        }
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init
            && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) {
            add(node.id.name, node.init);
        }
        return true;
    });
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
        /** @type {Map<string, Effects>} */
        let helpers = new Map();

        const enter = () => { frames.push({ writes: false, rereads: [] }); };
        const exit = () => {
            const frame = frames.pop();
            if (!frame?.writes) return;
            for (const node of frame.rereads) context.report({ node, messageId: 'reread' });
        };

        return {
            Program(node) { helpers = namedFunctions(node, context.sourceCode.visitorKeys); },
            FunctionDeclaration: enter,
            FunctionExpression: enter,
            ArrowFunctionExpression: enter,
            'FunctionDeclaration:exit': exit,
            'FunctionExpression:exit': exit,
            'ArrowFunctionExpression:exit': exit,
            CallExpression(node) {
                const frame = frames.at(-1);
                const name = calleeName(node);
                if (frame === undefined || name === undefined) return;
                const helper = node.callee.type === 'Identifier' ? helpers.get(name) : undefined;
                if (WRITES.has(name) || helper?.writes) frame.writes = true;
                if (VIEW_REREADS.has(name) || helper?.rereads) frame.rereads.push(node);
            },
        };
    },
};
