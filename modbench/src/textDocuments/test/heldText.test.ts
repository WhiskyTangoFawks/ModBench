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

import { heldText, isUnsaved, onHeldTextChanged } from '../heldText';

const document = (text: string, isDirty: boolean) => ({ getText: () => text, isDirty });

describe('the text VS Code holds for a document', () => {
  it('is its text', () => {
    expect(heldText(document('{}', false))).toBe('{}');
  });

  it('is unsaved while VS Code holds changes to it', () => {
    expect([isUnsaved(document('', true)), isUnsaved(document('', false))]).toEqual([true, false]);
  });

  it('reports a change to that document that changed text, and no other', () => {
    const mine = document('a', false);
    const heard = vi.fn();
    onHeldTextChanged(mine, heard);

    h.changed.forEach((l) => { l({ document: document('a', false), contentChanges: [{}] }); });
    h.changed.forEach((l) => { l({ document: mine, contentChanges: [] }); });
    expect(heard).not.toHaveBeenCalled();

    h.changed.forEach((l) => { l({ document: mine, contentChanges: [{}] }); });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('stops reporting once disposed', () => {
    const mine = document('a', false);
    const heard = vi.fn();
    onHeldTextChanged(mine, heard).dispose();

    h.changed.forEach((l) => { l({ document: mine, contentChanges: [{}] }); });

    expect(heard).not.toHaveBeenCalled();
  });
});
