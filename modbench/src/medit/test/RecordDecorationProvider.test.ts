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
import { recordResourceUri } from '../recordResourceUri';

describe('RecordDecorationProvider (#428)', () => {
  const uri = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm');

  it('returns undefined when the lookup reports no working-tree change', () => {
    const provider = new RecordDecorationProvider(() => 'None');
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('badges a Modified record with M and the git modified colour', () => {
    const provider = new RecordDecorationProvider(() => 'Modified');
    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toEqual({
      badge: 'M',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      tooltip: 'Modified',
    });
  });

  it('badges an Added record with A and the git added colour', () => {
    const provider = new RecordDecorationProvider(() => 'Added');
    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toEqual({
      badge: 'A',
      color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      tooltip: 'Added',
    });
  });

  it('passes (plugin, origin, formKey) parsed off the URI to the lookup', () => {
    const lookup = vi.fn().mockReturnValue('None');
    const provider = new RecordDecorationProvider(lookup);
    provider.provideFileDecoration(uri);
    expect(lookup).toHaveBeenCalledWith('Fallout4.esm', 'ModA', '000001:Fallout4.esm');
  });

  // The rival: a provider that skips the scheme check would wrongly decorate an unrelated
  // resourceUri that merely happens to carry a matching lookup key by coincidence.
  it('returns undefined for a URI outside the medit-record: scheme', () => {
    const provider = new RecordDecorationProvider(() => 'Modified');
    expect(provider.provideFileDecoration({ scheme: 'file', path: '/tmp/x' } as never)).toBeUndefined();
  });

  it('refresh(uri) fires onDidChangeFileDecorations for exactly that URI', () => {
    const provider = new RecordDecorationProvider(() => 'None');
    const handler = vi.fn();
    provider.onDidChangeFileDecorations(handler);

    provider.refresh(uri);

    expect(handler).toHaveBeenCalledWith(uri);
  });
});
