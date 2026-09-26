// ADR-0015 invariant 2: a command writes a system of record and returns, and the watcher brings
// the change back. A function that makes a Plugins write re-reads no view.

/** @import { Rule } from 'eslint' */
/** @import { CallExpression } from 'estree' */

export const REREAD_AFTER_PLUGINS_WRITE_MESSAGE =
    'A Plugins write writes its file and returns. The view changes only when the watch reads the file '
    + "back: the Instance loader's next value for plugins.txt, mEdit's published rows for plugin source. "
    + 'A write path never refreshes or invalidates the view, landed or failed (ADR-0015 invariant 2).';

// Every call that writes plugins.txt or plugin source from the Plugins view, by the name it is
// called under.
const PLUGINS_WRITES = new Set([
    'setPluginsParticipation', 'setPluginsEnabled', 'reorderPlugins', 'appendPlugin', 'onPluginCheckboxChanged',
    'createPlugin', 'track', 'createRecord', 'deleteRecords', 'copyRecords',
]);

const VIEW_REREADS = new Set(['invalidate', 'refresh', 'refreshFacts', 'refreshMatchingPlugins', 'refreshTree']);

/** @param {CallExpression} node */
function calleeName(node) {
    const { callee } = node;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
        return callee.property.name;
    }
    return undefined;
}

/** @typedef {{ writes: boolean, rereads: CallExpression[] }} Frame */

/** @type {Rule.RuleModule} */
export const noRereadAfterPluginsWrite = {
    meta: {
        type: 'problem',
        docs: {
            description: 'A function that makes a Plugins write never re-reads the view (ADR-0015 invariant 2).',
        },
        schema: [],
        messages: { reread: REREAD_AFTER_PLUGINS_WRITE_MESSAGE },
    },
    create(context) {
        /** @type {Frame[]} */
        const frames = [];
        /** @type {Set<CallExpression>} */
        const reported = new Set();

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
            FunctionDeclaration: enter,
            FunctionExpression: enter,
            ArrowFunctionExpression: enter,
            'FunctionDeclaration:exit': exit,
            'FunctionExpression:exit': exit,
            'ArrowFunctionExpression:exit': exit,
            CallExpression(node) {
                const name = calleeName(node);
                if (name === undefined) return;
                // A call inside a nested function is in every enclosing function's body too.
                if (PLUGINS_WRITES.has(name)) for (const frame of frames) frame.writes = true;
                if (VIEW_REREADS.has(name)) for (const frame of frames) frame.rereads.push(node);
            },
        };
    },
};
