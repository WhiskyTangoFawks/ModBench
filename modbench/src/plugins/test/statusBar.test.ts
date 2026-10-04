import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeItem { text: string; command?: unknown; shown: boolean; disposed: boolean }

const h = vi.hoisted(() => ({ items: [] as FakeItem[] }));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: () => {
      const item = {
        text: '', shown: false, disposed: false,
        show() { item.shown = true; },
        dispose() { item.disposed = true; },
      };
      h.items.push(item);
      return item;
    },
  },
}));

import { createStatusBar } from '../statusBar';
import { InMemoryMEditClient } from '../../client';
import { present } from '../../ports/present';

const theItem = (): FakeItem => present(h.items[0], 'the one status bar item');

beforeEach(() => { h.items.length = 0; });

describe('the status bar, one item saying what mEdit is doing', () => {
  it('shows mEdit\'s state from the start', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('stopped');

    createStatusBar(client);

    expect(h.items).toHaveLength(1);
    expect(theItem().text).toBe('$(circle-slash) mEdit: Stopped');
    expect(theItem().shown).toBe(true);
  });

  it.each([
    ['starting', '$(loading~spin) mEdit: Starting…'],
    ['running', '$(plug) mEdit: Running'],
    ['disconnected', '$(error) mEdit: Disconnected'],
    ['stopped', '$(circle-slash) mEdit: Stopped'],
  ] as const)('says %s on every change to it', (status, text) => {
    const client = new InMemoryMEditClient();
    createStatusBar(client);

    client.setStatus(status);

    expect(theItem().text).toBe(text);
  });

  it('says Ready once the snapshot is indexed, counting the active plugins', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    const bar = createStatusBar(client);

    bar.ready(2);

    expect(theItem().text).toBe('$(check) mEdit: Ready (2 plugins)');
  });

  it('gives Ready back to mEdit\'s own state once the snapshot is not indexed', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    const bar = createStatusBar(client);
    bar.ready(2);

    bar.notReady();

    expect(theItem().text).toBe('$(plug) mEdit: Running');
  });

  it('does nothing on a click', () => {
    createStatusBar(new InMemoryMEditClient());

    expect(theItem().command).toBeUndefined();
  });

  it('is gone once disposed, and hears no further change', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    const bar = createStatusBar(client);

    bar.dispose();
    client.setStatus('disconnected');

    expect(theItem().disposed).toBe(true);
    expect(theItem().text).toBe('$(plug) mEdit: Running');
  });
});
