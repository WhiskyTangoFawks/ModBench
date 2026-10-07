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
const text = (selection: readonly Row[]) =>
  viewCopyValueText<Row, 'copied'>(VIEW, ['copied'], (row) => row.text, () => selection);

describe('isKeyArgs: the args a view\'s own key passes', () => {
  it('holds for the view\'s args and for no other value', () => {
    expect(isKeyArgs({ view: VIEW }, VIEW)).toBe(true);
    expect(isKeyArgs({ view: 'modbench.otherView' }, VIEW)).toBe(false);
    expect(isKeyArgs(copied('a'), VIEW)).toBe(false);
    expect(isKeyArgs(undefined, VIEW)).toBe(false);
    expect(isKeyArgs(null, VIEW)).toBe(false);
  });
});

describe('viewCopyValueText: one view\'s share of the catalog\'s copy value', () => {
  it('copies the whole view selection, of the copied kinds, for the view\'s key', () => {
    expect(text([copied('a'), new OtherRow('x'), copied('b')])({ view: VIEW }, undefined)).toBe('a\nb');
  });

  it('copies nothing for the key when the view selects nothing', () => {
    expect(text([])({ view: VIEW }, undefined)).toBe('');
  });

  it('copies the selected rows when a row is right-clicked inside a selection', () => {
    const [a, b, c] = [copied('a'), copied('b'), copied('c')];
    expect(text([c])(a, [a, b])).toBe('a\nb');
  });

  it('copies the right-clicked row alone when it is outside the selection', () => {
    expect(text([copied('c')])(copied('a'), undefined)).toBe('a');
  });

  it('defers for another view\'s key, a row of another kind and the palette', () => {
    expect(text([copied('a')])({ view: 'modbench.otherView' }, undefined)).toBeUndefined();
    expect(text([copied('a')])(new OtherRow('x'), undefined)).toBeUndefined();
    expect(text([copied('a')])(undefined, undefined)).toBeUndefined();
  });
});
