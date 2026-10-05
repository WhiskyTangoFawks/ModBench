import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach((h) => h(e)); }
  },
}));

import * as vscode from 'vscode';
import { RecordDecorationProvider } from '../RecordDecorationProvider';
import { fakeUri } from '../../test/vscodeMock';
import type { WorkingTreeState } from '../../client/apiClient';

type Listener = (uris: readonly vscode.Uri[]) => void;

function source(state: WorkingTreeState | undefined | ((uri: vscode.Uri) => WorkingTreeState | undefined)) {
  const listeners: Listener[] = [];
  return {
    workingTreeStateOf: typeof state === 'function' ? state : () => state,
    onDidReadRecords: (listener: Listener) => { listeners.push(listener); return { dispose: () => undefined }; },
    read: (uris: readonly vscode.Uri[]) => { for (const listener of listeners) listener(uris); },
  };
}

describe('RecordDecorationProvider', () => {
  const uri = fakeUri('/a record row');

  it('returns undefined when the lookup reports no working-tree change', () => {
    const provider = new RecordDecorationProvider(source('None'));
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('badges a Modified record with M and the git modified colour', () => {
    const provider = new RecordDecorationProvider(source('Modified'));
    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toEqual({
      badge: 'M',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      tooltip: 'Modified',
    });
  });

  it('badges an Added record with A and the git added colour', () => {
    const provider = new RecordDecorationProvider(source('Added'));
    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toEqual({
      badge: 'A',
      color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      tooltip: 'Added',
    });
  });

  it('asks its source about the URI VS Code names', () => {
    const lookup = vi.fn().mockReturnValue('None');
    const provider = new RecordDecorationProvider(source(lookup));
    provider.provideFileDecoration(uri);
    expect(lookup).toHaveBeenCalledWith(uri);
  });

  it('fires onDidChangeFileDecorations for exactly the rows its source reads', () => {
    const badges = source('None');
    const provider = new RecordDecorationProvider(badges);
    const handler = vi.fn();
    provider.onDidChangeFileDecorations(handler);

    badges.read([uri]);

    expect(handler).toHaveBeenCalledWith([uri]);
  });
});
