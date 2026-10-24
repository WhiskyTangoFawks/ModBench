import { describe, it, expect, vi } from 'vitest';
import { TreeItem } from '../../test/vscodeMock';
import { copyValueVscode } from './copyValueHarness';

vi.mock('vscode', () => ({ ...copyValueVscode, TreeItem }));

import { isKeyArgs, viewCopyValueText } from '../copyValue';

class CopiedRow extends TreeItem {
  readonly kind = 'copied' as const;
  constructor(readonly text: string) { super(text); }
}
class OtherRow extends TreeItem {
  readonly kind = 'other' as const;
}
type Row = CopiedRow | OtherRow;

const VIEW = 'modbench.someView';
const copied = (name: string) => new CopiedRow(name);
const [a, b, c] = [copied('a'), copied('b'), copied('c')];
const other = new OtherRow('x');

describe('the args a view\'s own key passes', () => {
  it.each<[string, unknown, boolean]>([
    ['the view\'s args', { view: VIEW }, true],
    ['another view\'s args', { view: 'modbench.otherView' }, false],
    ['a row', a, false],
    ['nothing', undefined, false],
    ['null', null, false],
  ])('are told from %s', (_case, args, expected) => {
    expect(isKeyArgs(args, VIEW)).toBe(expected);
  });
});

describe('one view\'s share of the catalog\'s copy value', () => {
  it.each<[string, readonly Row[], unknown, readonly Row[] | undefined, string | undefined]>([
    ['copies the whole view selection, of the copied kinds, for the view\'s key', [a, other, b], { view: VIEW }, undefined, 'a\nb'],
    ['copies nothing for the key when the view selects nothing', [], { view: VIEW }, undefined, ''],
    ['copies the selected rows when a row is right-clicked inside a selection', [c], a, [a, b], 'a\nb'],
    ['copies the right-clicked row alone when it is outside the selection', [c], a, undefined, 'a'],
    ['defers for another view\'s key', [a], { view: 'modbench.otherView' }, undefined, undefined],
    ['defers for a row of another kind', [a], other, undefined, undefined],
    ['defers for the palette', [a], undefined, undefined, undefined],
  ])('%s', (_case, selection, clicked, selected, expected) => {
    expect(viewCopyValueText<Row, 'copied'>(VIEW, ['copied'], (row) => row.text, () => selection)(clicked, selected)).toBe(expected);
  });
});
