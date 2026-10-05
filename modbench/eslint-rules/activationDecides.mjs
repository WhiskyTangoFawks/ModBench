export const ACTIVATION_DECIDES_MESSAGE =
    'The composition root builds each box and registers it, and decides nothing: a branch, a loop, a default or a fork belongs to the box whose decision it is (ADR-0014).';

export const ACTIVATION_DECIDES_SELECTORS = [
    'IfStatement', 'SwitchStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
    'WhileStatement', 'DoWhileStatement', 'TryStatement', 'ConditionalExpression', 'LogicalExpression',
];
