import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
}));

import * as vscode from 'vscode';
import { FileOverrideDecorationProvider } from './FileOverrideDecorationProvider';
import type { ConflictEntry } from './fileConflictIndex';

// #447: reproduces the git-modified idiom (badge + themed color) — RecordDecorationProvider's own
// (#428) — for a Plugins-tree row whose plugin filename is a file override (more than one enabled
// mod provides it). Same resourceUri + FileDecorationProvider pattern as
// ImplicitMasterDecorationProvider/HiddenDownloadDecorationProvider/OverwriteDecorationProvider.
describe('FileOverrideDecorationProvider (#447)', () => {
  const winnerPath = join('/mods', 'ModA', 'Shared.esp');
  const entry = (overrides: Partial<ConflictEntry> = {}): ConflictEntry => ({
    relativePath: 'Shared.esp',
    winner: winnerPath,
    winnerMod: 'ModA',
    providers: ['ModA', 'ModB'],
    ...overrides,
  });
  const uri = (fsPath: string) => ({ fsPath } as never);

  it('badges and tints a row whose resourceUri is a flagged file override', () => {
    const provider = new FileOverrideDecorationProvider(() => new Map([['shared.esp', entry()]]));
    const decoration = provider.provideFileDecoration(uri(winnerPath));

    expect(decoration).toBeDefined();
    expect(decoration!.badge).toBe('2');
    // RecordDecorationProvider's own git-modified idiom (#428) — check the id itself, not just
    // that some color object was constructed.
    expect(decoration!.color).toEqual(new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
  });

  it('caps the badge at two characters for a double-digit provider count', () => {
    const providers = Array.from({ length: 11 }, (_, i) => `Mod${i}`);
    const provider = new FileOverrideDecorationProvider(() => new Map([['shared.esp', entry({ providers })]]));
    const decoration = provider.provideFileDecoration(uri(winnerPath));

    expect(decoration!.badge).toBe('9+');
  });

  it('returns undefined for a URI that is not a flagged file override', () => {
    const provider = new FileOverrideDecorationProvider(() => new Map([['shared.esp', entry()]]));
    expect(provider.provideFileDecoration(uri(join('/mods', 'Solo', 'Solo.esp')))).toBeUndefined();
  });

  it('returns undefined when fileOverrides() is empty (uncontested tree)', () => {
    const provider = new FileOverrideDecorationProvider(() => new Map());
    expect(provider.provideFileDecoration(uri(winnerPath))).toBeUndefined();
  });

  it('matches a case-variant path against the folded winner path (#128 convention)', () => {
    const provider = new FileOverrideDecorationProvider(() => new Map([['shared.esp', entry()]]));
    const decoration = provider.provideFileDecoration(uri(winnerPath.toUpperCase()));
    expect(decoration).toBeDefined();
  });
});
