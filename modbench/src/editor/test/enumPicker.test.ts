import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQuickPick, editorVscode, type FakePanel } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import { settled } from '../../test/eventually';
import { editorOver, forgetEditor } from './editorHarness';

beforeEach(forgetEditor);

const choices = [{ value: 'A', label: 'Alpha' }, { value: 'B', label: 'Beta' }];

function open(current: string) {
  const fake = fakeQuickPick<{ label: string; value: string }>();
  createQuickPick.mockReturnValue(fake.qp);
  const tab = editorOver().open('000801:A.esp');
  tab.receive({ type: WEBVIEW_TO_EXTENSION.OPEN_ENUM_PICKER, requestId: 'e1', choices, current });
  return { ...fake, tab };
}

const picked = (tab: FakePanel, value: string | null) => settled(() => {
  expect(tab.webview.postMessage).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.ENUM_PICKED, requestId: 'e1', value });
});

describe('the enum pick', () => {
  it('lists the names and opens on the current one', async () => {
    const { qp, escape, tab } = open('B');
    await settled(() => { expect(qp.show).toHaveBeenCalled(); });
    escape();
    await picked(tab, null);

    expect(qp.items.map(i => i.label)).toEqual(['Alpha', 'Beta']);
    expect(qp.activeItems.map(i => i.label)).toEqual(['Beta']);
  });

  it('yields the chosen name\'s value', async () => {
    const { accept, tab } = open('A');
    accept({ label: 'Beta', value: 'B' });

    await picked(tab, 'B');
  });

  it('yields null on Esc', async () => {
    const { escape, tab } = open('A');
    escape();

    await picked(tab, null);
  });
});
