import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, Uri } from './vscodeHost';
import { instanceHolding, sourceLanguageOver } from './sourceLanguageOver';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const SOURCE_DIRS = new Map([['ModA', '/instance/source/ModA'], ['ModB', '/instance/source/ModB']]);
const BUILD = 'modbench.source.build';

const valueHolding = (sourceDirs: ReadonlyMap<string, string>) =>
  instanceValueFixture({ paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs } });

function registered(sourceDirs = SOURCE_DIRS) {
  const instance = instanceHolding(valueHolding(sourceDirs));
  return { ...sourceLanguageOver({ instance }), instance };
}

const carrying = (...names: string[]) => names.map((name) => ({ argument: { kind: 'mod', name } }));
const built = () => host.executed.filter(([id]) => id === 'modbench.mod.build');

describe('the build entry point (source.md, Menus and keys)', () => {
  it('tells the menus which resources are a source mod\'s folder or build file, as the source mods change', () => {
    const { instance } = registered(new Map([['ModA', '/instance/source/ModA']]));
    const atStart = host.context('modbench.source.buildTargets');

    instance.land(valueHolding(SOURCE_DIRS));

    expect([atStart, host.context('modbench.source.buildTargets')]).toEqual([
      ['file:///instance/source/ModA', 'file:///instance/source/ModA/build.json'],
      ['file:///instance/source/ModA', 'file:///instance/source/ModA/build.json', 'file:///instance/source/ModB', 'file:///instance/source/ModB/build.json'],
    ]);
  });

  it('fires build with the mods the folders and build files stand for, each once', async () => {
    registered();
    const folderA = Uri.file('/instance/source/ModA');
    const fileA = Uri.file('/instance/source/ModA/build.json');
    const folderB = Uri.file('/instance/source/ModB');

    await host.run(BUILD, folderA, [folderA, fileA, folderB]);

    expect(built()).toEqual([['modbench.mod.build', carrying('ModA')[0], carrying('ModA', 'ModB')]]);
  });

  it('fires build for the one resource a run button names', async () => {
    registered();

    await host.run(BUILD, Uri.file('/instance/source/ModB/build.json'));

    expect(built()).toEqual([['modbench.mod.build', carrying('ModB')[0], carrying('ModB')]]);
  });

  it('refuses a resource that is no source mod\'s, by name, and builds nothing', async () => {
    const { reporter } = registered();

    await host.run(BUILD, Uri.file('/elsewhere/build.json'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build "/elsewhere/build.json".', detail: 'It is not a source mod\'s source folder or build file.' },
    ]);
    expect(built()).toEqual([]);
  });
});
