import { describe, it, expect, vi } from 'vitest';

interface Change { document: object; contentChanges: unknown[] }
const h = vi.hoisted(() => ({ changed: [] as ((change: Change) => void)[] }));

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeTextDocument: (listener: (change: Change) => void) => {
      h.changed.push(listener);
      return { dispose: () => { h.changed.splice(h.changed.indexOf(listener), 1); } };
    },
  },
}));

import { onHeldTextChanged } from '../heldText';

const document = (text: string, isDirty: boolean) => ({ getText: () => text, isDirty });
const changed = (change: Change) => { h.changed.forEach((listener) => { listener(change); }); };

describe('the text VS Code holds for a document', () => {
  it('reports a change to that document that changed text, and no other', () => {
    const mine = document('a', false);
    const heard = vi.fn();
    onHeldTextChanged(mine, heard);

    changed({ document: document('a', false), contentChanges: [{}] });
    changed({ document: mine, contentChanges: [] });
    expect(heard).not.toHaveBeenCalled();

    changed({ document: mine, contentChanges: [{}] });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('stops reporting once disposed', () => {
    const mine = document('a', false);
    const heard = vi.fn();
    onHeldTextChanged(mine, heard).dispose();

    changed({ document: mine, contentChanges: [{}] });

    expect(heard).not.toHaveBeenCalled();
  });
});
