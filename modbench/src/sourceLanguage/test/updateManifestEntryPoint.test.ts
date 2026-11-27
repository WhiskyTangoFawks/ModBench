import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, Uri } from './vscodeHost';
import { instanceHolding, sourceLanguageOver } from './sourceLanguageOver';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const SOURCE_DIRS = new Map([['ModA', '/instance/source/ModA'], ['ModB', '/instance/source/ModB']]);
const UPDATE = 'modbench.source.updateManifest';

const valueHolding = (sourceDirs: ReadonlyMap<string, string>) =>
  instanceValueFixture({ paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs } });

function registered(sourceDirs = SOURCE_DIRS) {
  const instance = instanceHolding(valueHolding(sourceDirs));
  return { ...sourceLanguageOver({ instance }), instance };
}

const folder = (path: string) => ({ argument: { kind: 'folder', path } });
const updated = () => host.executed.filter(([id]) => id === 'modbench.mod.updateManifest');

describe('the update manifest entry point (source.md, Menus and keys)', () => {
  it('tells the menu which folders are a source mod\'s source folder, as the source mods change', () => {
    const { instance } = registered(new Map([['ModA', '/instance/source/ModA']]));
    const atStart = host.context('modbench.source.sourceFolders');

    instance.land(valueHolding(SOURCE_DIRS));

    expect([atStart, host.context('modbench.source.sourceFolders')]).toEqual([['/instance/source/ModA'], ['/instance/source/ModA', '/instance/source/ModB']]);
  });

  it('fires update manifest with the source folders the manifests lie in, each once', async () => {
    registered();
    const manifestA = Uri.file('/instance/source/ModA/ModA.manifest.json');
    const otherA = Uri.file('/instance/source/ModA/other.manifest.json');
    const manifestB = Uri.file('/instance/source/ModB/ModB.manifest.json');

    await host.run(UPDATE, manifestA, [manifestA, otherA, manifestB]);

    expect(updated()).toEqual([['modbench.mod.updateManifest', folder('/instance/source/ModA'), [folder('/instance/source/ModA'), folder('/instance/source/ModB')]]]);
  });

  it('finds the source folder of a manifest whose drive letter differs in case, as the real Uri writes it in lower case', async () => {
    registered(new Map([['ModA', 'C:/instance/source/ModA']]));

    await host.run(UPDATE, Uri.file('c:/instance/source/ModA/ModA.manifest.json'));

    expect(updated()).toEqual([['modbench.mod.updateManifest', folder('C:/instance/source/ModA'), [folder('C:/instance/source/ModA')]]]);
  });

  it('refuses a manifest outside every source folder, by name, and records nothing', async () => {
    const { reporter } = registered();

    await host.run(UPDATE, Uri.file('/elsewhere/X.manifest.json'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not update the manifest "/elsewhere/X.manifest.json".', detail: 'It is not in a source mod\'s source folder.' },
    ]);
    expect(updated()).toEqual([]);
  });
});
