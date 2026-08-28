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

// #364: the record conflict badge — ADR-0016's Axis 1 (record-wide ConflictAll) only. Every test
// in this block uses a Conflicts-node-flavored URI (the 4th recordResourceUri argument) — the
// "conflict badge scoping" block below is what proves an *ordinary* URI never gets one, even when
// the exact same lookup would answer with a real value.
describe('RecordDecorationProvider — conflict badge (#364)', () => {
  const uri = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm', true);

  it('badges an Override record with O and green', () => {
    const provider = new RecordDecorationProvider(() => 'None', () => 'Override');
    expect(provider.provideFileDecoration(uri)).toEqual({
      badge: 'O',
      color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      tooltip: 'Override',
    });
  });

  it('badges a Conflict record with C and the git conflicting colour', () => {
    const provider = new RecordDecorationProvider(() => 'None', () => 'Conflict');
    expect(provider.provideFileDecoration(uri)).toEqual({
      badge: 'C',
      color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'),
      tooltip: 'Conflict',
    });
  });

  it('badges a ConflictCritical record with ! and the error colour', () => {
    const provider = new RecordDecorationProvider(() => 'None', () => 'ConflictCritical');
    expect(provider.provideFileDecoration(uri)).toEqual({
      badge: '!',
      color: new vscode.ThemeColor('problemsErrorIcon.foreground'),
      tooltip: 'Conflict (critical)',
    });
  });

  // medit-record-editor.md's "no tint" rule: OnlyOne/NoConflict never render a badge — a
  // background color (or, here, a badge) is reserved for "something needs attention".
  it.each(['OnlyOne', 'NoConflict'] as const)('renders nothing for %s', (conflictAll) => {
    const provider = new RecordDecorationProvider(() => 'None', () => conflictAll);
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  // #307's own invariant, given a concrete rival to fail against: a lookup answering undefined
  // (PluginTreeProvider.conflictAllOf's own gate on conflictsComputed, or simply "nothing has
  // fetched this record's conflict state yet") must render nothing — never a badge that could be
  // mistaken for "no conflict". The rival — "render a neutral badge when unknown" — is exactly the
  // failure mode this test exists to catch; there is no neutral badge to fall back to here, by
  // construction (the switch's default case returns undefined, not a fallback badge value).
  it('renders nothing when the conflict lookup reports nothing at all (not computed / not fetched)', () => {
    const provider = new RecordDecorationProvider(() => 'None', () => undefined);
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('renders nothing when no conflictAllLookup is wired at all — the two-argument constructor form still works', () => {
    const provider = new RecordDecorationProvider(() => 'None');
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  // Rival named — the orchestrator-approved default this test pins: a wrong implementation that
  // checks conflictAllLookup first (or that composes both into one decoration) would show the
  // conflict badge, the Conflict color, or some combination here instead of the plain M badge.
  it('prefers the M/A working-tree badge over a conflict badge when both are present', () => {
    const provider = new RecordDecorationProvider(() => 'Modified', () => 'Conflict');
    expect(provider.provideFileDecoration(uri)).toEqual({
      badge: 'M',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      tooltip: 'Modified',
    });
  });

  it('passes (plugin, origin, formKey) parsed off the URI to the conflict lookup too', () => {
    const conflictLookup = vi.fn().mockReturnValue('Conflict');
    const provider = new RecordDecorationProvider(() => 'None', conflictLookup);
    provider.provideFileDecoration(uri);
    expect(conflictLookup).toHaveBeenCalledWith('Fallout4.esm', 'ModA', '000001:Fallout4.esm');
  });
});

// #364 review finding: the badge must render only on the Conflicts node's own rows — the AC's
// explicit scope decision, contradicted by the original implementation (a bare identity-keyed
// lookup badges every URI sharing that identity, including an ordinary RecordTypeNode -> RecordNode
// row for the same record elsewhere in the tree). No test caught this the first time; these do.
describe('RecordDecorationProvider — conflict badge scoping (#364 review)', () => {
  it('never calls the conflict lookup at all for an ordinary (non-Conflicts-node) URI', () => {
    const conflictLookup = vi.fn().mockReturnValue('Conflict');
    const ordinaryUri = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm', false);
    const provider = new RecordDecorationProvider(() => 'None', conflictLookup);

    const decoration = provider.provideFileDecoration(ordinaryUri);

    expect(decoration).toBeUndefined();
    expect(conflictLookup).not.toHaveBeenCalled();
  });

  // The direct cross-tree proof: the identical lookup, identical identity — the only difference
  // between these two calls is which URI flavor asked.
  it('badges the Conflicts-node URI but not the ordinary URI for the same (plugin, origin, formKey)', () => {
    const conflictLookup = vi.fn().mockReturnValue('Conflict');
    const provider = new RecordDecorationProvider(() => 'None', conflictLookup);
    const ordinaryUri = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm', false);
    const conflictsUri = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm', true);

    expect(provider.provideFileDecoration(conflictsUri)).toEqual({
      badge: 'C',
      color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'),
      tooltip: 'Conflict',
    });
    expect(provider.provideFileDecoration(ordinaryUri)).toBeUndefined();
  });
});
