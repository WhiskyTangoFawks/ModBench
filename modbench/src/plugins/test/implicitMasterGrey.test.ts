import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, ThemeColor, Uri } from './vscodeHost';
import { pluginsOver, pluginsOfModA } from './pluginsOver';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const GREY = { color: new ThemeColor('disabledForeground') };

async function greying() {
  const made = pluginsOver({
    value: instanceValueFixture({ plugins: pluginsOfModA(['Fallout4.esm']), pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }] }),
  });
  const row = await made.pluginRows();
  const uriOf = async (name: string, origin?: string) => (await made.item(row(name, origin))).resourceUri;
  return { uriOf };
}

describe('the row of a plugin the game loads with no line', () => {
  it('is greyed as MO2 greys a forceLoaded row, with the disabledForeground theme color and no badge', async () => {
    const { uriOf } = await greying();

    expect(await host.decorate(await uriOf('Fallout4.esm', 'Data/'))).toContainEqual(GREY);
  });

  it.each([
    ['the plugin file an Explorer row shows', () => Promise.resolve(Uri.file('/game/Data/Fallout4.esm'))],
    ['the row of the same file name a mod\'s line holds', (uriOf: (name: string) => Promise<unknown>) => uriOf('Fallout4.esm')],
  ])('greys nothing else: not %s', async (_case, uri) => {
    const { uriOf } = await greying();

    expect(await host.decorate(await uri(uriOf))).not.toContainEqual(GREY);
  });
});
