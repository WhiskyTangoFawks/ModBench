// commands.md, "An entry point fires a gesture. A gesture does not fire another.": an entry
// point passes `vscode.commands.executeCommand('modbench.…', …)`'s Argument and uses no result.
// This rule holds that at the lint gate.

/** @import { Rule } from 'eslint' */
/** @import { CallExpression, Node } from 'estree' */

export const GESTURE_RESULT_USED_MESSAGE =
    "An entry point may fire a gesture and use no result. A gesture that needs another box's work "
    + 'calls that box through a reference the reference view draws.';

/**
 * @param {Node} node
 * @param {string} name
 */
function isIdentifier(node, name) {
    return node.type === 'Identifier' && node.name === name;
}

/**
 * @param {Node} node
 * @param {string} property
 */
function isDottedMember(node, property) {
    return node.type === 'MemberExpression' && !node.computed && isIdentifier(node.property, property);
}

/** @param {CallExpression} node */
function isGestureCall(node) {
    const { callee } = node;
    if (callee.type !== 'MemberExpression' || !isDottedMember(callee, 'executeCommand')) return false;
    const { object } = callee;
    if (object.type !== 'MemberExpression' || !isDottedMember(object, 'commands')) return false;
    if (!isIdentifier(object.object, 'vscode')) return false;
    const [first] = node.arguments;
    return first?.type === 'Literal' && typeof first.value === 'string' && first.value.startsWith('modbench.');
}

/**
 * The node whose parent decides whether the call's result is used: the call itself, or the
 * `await` around it when the call is awaited directly.
 * @param {CallExpression & Rule.NodeParentExtension} call
 * @returns {Node & Rule.NodeParentExtension}
 */
function valueNodeFor(call) {
    const { parent } = call;
    return parent.type === 'AwaitExpression' && parent.argument === call ? parent : call;
}

/**
 * Fire-only shapes: a bare statement (`x;`), a voided one (`void x;`), awaited or not, and a
 * callback whose whole body is the call (`() => x`), a relay with nothing to use the result for.
 * @param {Node & Rule.NodeParentExtension} valueNode
 */
function isFireOnly(valueNode) {
    const { parent } = valueNode;
    if (parent.type === 'ExpressionStatement') return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'void') return true;
    return parent.type === 'ArrowFunctionExpression' && parent.body === valueNode;
}

/** @type {Rule.RuleModule} */
export const noGestureResultUse = {
    meta: {
        type: 'problem',
        docs: {
            description: 'An entry point fires a gesture and uses no result (commands.md).',
        },
        schema: [],
        messages: { used: GESTURE_RESULT_USED_MESSAGE },
    },
    create(context) {
        return {
            CallExpression(node) {
                if (!isGestureCall(node)) return;
                if (isFireOnly(valueNodeFor(node))) return;
                context.report({ node, messageId: 'used' });
            },
        };
    },
};
