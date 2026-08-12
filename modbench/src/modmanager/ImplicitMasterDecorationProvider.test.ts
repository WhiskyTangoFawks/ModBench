import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
}));

import { ImplicitMasterDecorationProvider } from './ImplicitMasterDecorationProvider';

// #276: reproduces MO2's `foregroundData()` graying of `COL_NAME` for a `forceLoaded` row
// (`pluginlist.cpp`) — the one piece of MO2's forced-master presentation the platform *does*
// let this surface adopt verbatim (unlike the checkbox itself, see ImplicitMasterNode). Same
// resourceUri + FileDecorationProvider pattern as HiddenDownloadDecorationProvider (#238).
describe('ImplicitMasterDecorationProvider (#276)', () => {
  const dataFolder = '/game/Data';
  const dataUri = (name: string) => ({ fsPath: join(dataFolder, name) } as never);

  it('grays an implicit master row', async () => {
    const provider = new ImplicitMasterDecorationProvider(Promise.resolve(dataFolder), () => new Set(['fallout4.esm']));
    const decoration = await provider.provideFileDecoration(dataUri('Fallout4.esm'));
    expect(decoration).toBeDefined();
    expect(decoration!.color).toBeDefined();
    expect(decoration!.badge).toBeUndefined();
  });

  it('returns undefined for a plugin that is not an implicit master', async () => {
    const provider = new ImplicitMasterDecorationProvider(Promise.resolve(dataFolder), () => new Set(['fallout4.esm']));
    expect(await provider.provideFileDecoration(dataUri('Mod.esp'))).toBeUndefined();
  });

  it('returns undefined for a URI outside the resolved Data folder', async () => {
    const provider = new ImplicitMasterDecorationProvider(Promise.resolve(dataFolder), () => new Set(['fallout4.esm']));
    expect(await provider.provideFileDecoration({ fsPath: '/other/Fallout4.esm' } as never)).toBeUndefined();
  });

  it('degrades to undefined when the Data folder never resolved', async () => {
    const provider = new ImplicitMasterDecorationProvider(Promise.resolve(undefined), () => new Set(['fallout4.esm']));
    expect(await provider.provideFileDecoration(dataUri('Fallout4.esm'))).toBeUndefined();
  });
});
