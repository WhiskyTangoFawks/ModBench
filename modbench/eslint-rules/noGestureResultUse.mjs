// commands.md, "An entry point fires a gesture. A gesture does not fire another.": an entry
// point passes `vscode.commands.executeCommand('modbench.…', …)`'s Argument and uses no result.
// This rule holds that at the lint gate.

export const GESTURE_RESULT_USED_MESSAGE =
    "An entry point may fire a gesture and use no result. A gesture that needs another box's work "
    + 'calls that box through a reference the reference view draws.';

function isGestureCall(node) {
    if (node.type !== 'CallExpression') return false;
    const { callee } = node;
    if (callee.type !== 'MemberExpression' || callee.computed) return false;
    if (callee.property.type !== 'Identifier' || callee.property.name !== 'executeCommand') return false;
    const { object } = callee;
    if (object.type !== 'MemberExpression' || object.computed) return false;
    if (object.property.type !== 'Identifier' || object.property.name !== 'commands') return false;
    if (object.object.type !== 'Identifier' || object.object.name !== 'vscode') return false;
    const [first] = node.arguments;
    return first !== undefined && first.type === 'Literal' && typeof first.value === 'string'
        && first.value.startsWith('modbench.');
}

// The node whose parent decides whether the call's result is used: the call itself, or the
// `await` around it when the call is awaited directly.
function valueNodeFor(call) {
    const { parent } = call;
    return parent.type === 'AwaitExpression' && parent.argument === call ? parent : call;
}

// Fire-only shapes: a bare statement (`x;`), a voided statement (`void x;`), awaited or not, and
// a callback whose entire body is the call (`() => x`) — a relay with nothing of its own to use
// the result for.
function isFireOnly(valueNode) {
    const { parent } = valueNode;
    if (parent.type === 'ExpressionStatement') return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'void') return true;
    if (parent.type === 'ArrowFunctionExpression' && parent.body === valueNode) return true;
    return false;
}

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
