import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  Uri: {
    file: (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
    from: ({ scheme, path }: { scheme: string; path: string }) => ({ scheme, path, toString: () => `${scheme}://${path}` }),
  },
}));

import * as vscode from 'vscode';
import { ImplicitMasterDecorationProvider, lockedRowUri } from '../ImplicitMasterDecorationProvider';
import { present } from '../../ports/present';

// MO2 grays a `forceLoaded` row's name (`pluginlist.cpp`) — the one piece of its
// forced-master presentation the platform lets this surface adopt verbatim.
describe('ImplicitMasterDecorationProvider', () => {
  const FALLOUT4 = lockedRowUri('/game/Data/Fallout4.esm');
  const providerOver = (...rows: vscode.Uri[]) =>
    new ImplicitMasterDecorationProvider(() => new Set(rows.map((uri) => uri.toString())));

  it('grays a locked row the tree renders', () => {
    const decoration = present(providerOver(FALLOUT4).provideFileDecoration(FALLOUT4), 'the decoration for the locked row');
    // MO2's foregroundData() grays via this exact theme color — check the
    // id itself, not just that some color object was constructed.
    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
    expect(decoration.badge).toBeUndefined();
  });

  // The grey belongs to the locked row, never to the plugin file an Explorer row shows.
  it('returns undefined for the implicit master\'s own file', () => {
    expect(providerOver(FALLOUT4).provideFileDecoration(vscode.Uri.file('/game/Data/Fallout4.esm'))).toBeUndefined();
  });

  it('returns undefined for a locked-row URI the tree does not render', () => {
    expect(providerOver(FALLOUT4).provideFileDecoration(lockedRowUri('/game/Data2/Fallout4.esm'))).toBeUndefined();
  });

  it('greys nothing while the tree renders no locked row', () => {
    expect(providerOver().provideFileDecoration(FALLOUT4)).toBeUndefined();
  });
});
