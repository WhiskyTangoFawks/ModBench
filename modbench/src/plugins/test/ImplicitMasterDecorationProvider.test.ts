import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

// Real `Uri.file` forward-slashes a backslash path only on Windows; this always does, so a
// Windows-style fixture below exercises that conversion on any host.
vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  Uri: {
    file: (p: string) => {
      const path = p.replaceAll('\\', '/');
      return { fsPath: p, path, toString: () => `file://${path}` };
    },
  },
}));

import * as vscode from 'vscode';
import { ImplicitMasterDecorationProvider } from '../ImplicitMasterDecorationProvider';
import { fakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';

// MO2 grays a `forceLoaded` row's name (`pluginlist.cpp`) — the one piece of its
// forced-master presentation the platform lets this surface adopt verbatim.
describe('ImplicitMasterDecorationProvider', () => {
  const dataFolder = '/game/Data';
  const dataUri = (name: string) => fakeUri(join(dataFolder, name));

  it('grays an implicit master row', async () => {
    const provider = new ImplicitMasterDecorationProvider(() => Promise.resolve(dataFolder), () => new Set(['fallout4.esm']));
    const decoration = present(await provider.provideFileDecoration(dataUri('Fallout4.esm')), 'the decoration for an implicit master row');
    // MO2's foregroundData() grays via this exact theme color — check the
    // id itself, not just that some color object was constructed.
    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
    expect(decoration.badge).toBeUndefined();
  });

  it('returns undefined for a plugin that is not an implicit master', async () => {
    const provider = new ImplicitMasterDecorationProvider(() => Promise.resolve(dataFolder), () => new Set(['fallout4.esm']));
    expect(await provider.provideFileDecoration(dataUri('Mod.esp'))).toBeUndefined();
  });

  it('returns undefined for a URI outside the resolved Data folder', async () => {
    const provider = new ImplicitMasterDecorationProvider(() => Promise.resolve(dataFolder), () => new Set(['fallout4.esm']));
    expect(await provider.provideFileDecoration(fakeUri('/other/Fallout4.esm'))).toBeUndefined();
  });

  // A permissive set isolates the parent-URI guard from the name guard below.
  class PermissiveSet extends Set<string> {
    override has(): boolean { return true; }
  }
  const permissive = (): ReadonlySet<string> => new PermissiveSet();

  // VS Code calls this provider for every workspace URI, not just ones under Data — a sibling
  // folder like Data2/ has a different parent URI, never equal to the Data folder's own.
  it('returns undefined for a sibling folder whose name is Data-prefixed', async () => {
    const provider = new ImplicitMasterDecorationProvider(() => Promise.resolve(dataFolder), permissive);
    expect(
      await provider.provideFileDecoration(fakeUri('/game/Data2/Fallout4.esm')),
    ).toBeUndefined();
  });

  it('returns undefined for a URI outside the Data folder even if implicitMasterNames would match anything', async () => {
    const provider = new ImplicitMasterDecorationProvider(() => Promise.resolve(dataFolder), permissive);
    expect(await provider.provideFileDecoration(fakeUri('/other/Fallout4.esm'))).toBeUndefined();
  });

  it('degrades to undefined when the Data folder never resolved', async () => {
    const provider = new ImplicitMasterDecorationProvider(() => Promise.resolve(undefined), () => new Set(['fallout4.esm']));
    expect(await provider.provideFileDecoration(dataUri('Fallout4.esm'))).toBeUndefined();
  });

  // Rival this rules out: comparing by `.fsPath` with a hardcoded `/` join, which never matches a
  // real Windows `fsPath` (backslash-separated) against a POSIX-style literal.
  it('grays an implicit master row given a Windows-style Data folder and file path', async () => {
    const winDataFolder = String.raw`C:\Game\Data`;
    const provider = new ImplicitMasterDecorationProvider(() => Promise.resolve(winDataFolder), () => new Set(['fallout4.esm']));
    const uri = vscode.Uri.file(String.raw`C:\Game\Data\Fallout4.esm`);

    const decoration = present(await provider.provideFileDecoration(uri), 'the decoration for the Windows-style row');

    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
  });
});
