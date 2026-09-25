// common.md, The status bar, spells the status bar item's text out verbatim, "mEdit:" after its
// icon; every other surface speaks as Modbench.

export const LEADING_MEDIT_MESSAGE =
    'A message never begins "mEdit:". Every notification, Output line, tree row and webview text is '
    + "Modbench's own voice, and the Output channel is called Modbench. mEdit is named in a sentence "
    + 'that is about it, never as a label. Only the status bar item carries the prefix, after its icon: '
    + '"$(plug) mEdit: Attached" (common.md, The status bar).';

const LEADING_MEDIT = /^\s*mEdit:/i;

export const noLeadingMEdit = {
    meta: {
        type: 'problem',
        docs: {
            description: 'A message never begins "mEdit:"; only the status bar item names mEdit as a prefix.',
        },
        schema: [],
        messages: { prefixed: LEADING_MEDIT_MESSAGE },
    },
    create(context) {
        const check = (node, text) => {
            if (LEADING_MEDIT.test(text)) context.report({ node, messageId: 'prefixed' });
        };
        return {
            Literal(node) {
                if (typeof node.value === 'string') check(node, node.value);
            },
            TemplateLiteral(node) {
                const [head] = node.quasis;
                if (head !== undefined) check(node, head.value.raw);
            },
            JSXText(node) {
                check(node, node.value);
            },
        };
    },
};
