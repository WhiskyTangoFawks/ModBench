import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { seen } from './modsVscode';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import type { OriginFile } from '../../instanceLoader/instance';
import { file, folder, indexedValueOf, mod } from './indexedValue';
import { HeldModStatuses } from '../../test/heldModStatuses';
import { status } from '../../test/modStatusFixture';

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });
const hiddenUnderFolder = (relativePath: string, markedExcluded: boolean): OriginFile => ({ ...file('On', relativePath, true), markedExcluded });

const ENTRIES = [
  separator('Group'), separator('Other'), separator('Pack - One'), separator('Pack - Two'),
  mod('On'), mod('Off', false), mod('Source'), mod('Settings'),
];

async function shownWithEveryRowKind() {
  const value = await indexedValueOf(ENTRIES, {
    On: {
      files: [
        file('On', 'On.esp'), file('On', 'textures/a.dds'), file('On', 'x/a.dds'), file('On', 'a.dds'), file('On', 'b.dds.mohidden', true),
        hiddenUnderFolder('x.mohidden/c.dds', false), hiddenUnderFolder('x.mohidden/d.dds.mohidden', true),
        file('On', 'readme.txt'), file('On', 'docs/r.txt'),
      ],
      folders: [folder('On', 'textures'), folder('On', 'x'), folder('On', 'x.mohidden', true), folder('On', 'docs')],
    },
    Settings: { files: [file('Settings', 'x/a.dds')], folders: [folder('Settings', 'x')] },
  });
  const statuses = new HeldModStatuses();
  statuses.answer([status('On', { ignored: ['readme.txt', 'docs/r.txt'], ignoreEntries: ['readme.txt', 'docs'] })]);
  const shown = modsViewOn({
    value: {
      ...value, holdsRepository: true, listedSourceMods: new Set(['Source']),
      plugins: [{ name: 'On.esp', path: '/instance/On/On.esp', origin: 'On', line: 0, enabled: true, winning: true }],
    },
    statuses,
  });
  const { row } = shown;
  const [on, settings, pack] = [await row('On'), await row('Settings'), await row('Pack')];
  const [textures, x, hiding, docs, settingsX] = [await row('textures', on), await row('x', on), await row('x.mohidden', on), await row('docs', on), await row('x', settings)];
  const rows = {
    on, off: await row('Off'), source: await row('Source'), settings, group: await row('Group'), other: await row('Other'), pack,
    overwrite: await row('Overwrite'), textures, texturesLeaf: await row('a.dds', textures),
    winning: await row('a.dds', x), losing: await row('a.dds', settingsX), alone: await row('a.dds', on),
    excluded: await row('b.dds.mohidden', on), plainInFolder: await row('c.dds', hiding), markedInFolder: await row('d.dds.mohidden', hiding),
    entry: await row('readme.txt', on), under: await row('r.txt', docs),
  };
  type Name = keyof typeof rows;
  const keysOver = (...names: Name[]): Record<string, unknown> => {
    shown.view.selectRows(names.map((name) => rows[name]));
    return Object.fromEntries([...seen.contextKeys].map(([key, held]) => [key.replace('modbench.mod.', ''), held]));
  };
  return { ...shown, rows, keysOver };
}

describe('what the Mods keys read off the selection', () => {
  it('Space disables a selection of enabled mods, and enables a selection of disabled ones', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([keysOver('on').selectionToggle, keysOver('off').selectionToggle]).toEqual(['disable', 'enable']);
  });

  it('Space takes the first selected mod\'s direction over a mixed selection', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([keysOver('group', 'off', 'on').selectionToggle, keysOver('on', 'off').selectionToggle]).toEqual(['enable', 'disable']);
  });

  it('the palette\'s version in git sees a selection that holds a mod with no repository, whether or not it provides a plugin', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([
      keysOver('source', 'on').holdsNonSourceMod, keysOver('source', 'settings').holdsNonSourceMod,
      keysOver('source').holdsNonSourceMod, keysOver('source', 'group').holdsNonSourceMod, keysOver().holdsNonSourceMod,
    ]).toEqual([true, true, false, false, false]);
  });

  it('Space does nothing over a selection with no mod', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([keysOver('group').selectionToggle, keysOver().selectionToggle]).toEqual([undefined, undefined]);
  });

  it('Delete and F2 see one kind: mods, or separators', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([keysOver('on', 'off').selectionKind, keysOver('group', 'other').selectionKind]).toEqual(['mod', 'separator']);
  });

  it('Delete and F2 see no kind over a selection mixing mods and separators, or over none', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([keysOver('on', 'group').selectionKind, keysOver().selectionKind]).toEqual([undefined, undefined]);
  });

  it.each<[string, ['on' | 'off' | 'group', 'texturesLeaf' | 'textures' | 'pack']]>([
    ['an enabled mod and a file', ['on', 'texturesLeaf']],
    ['a disabled mod and a folder', ['off', 'textures']],
    ['a separator and a file', ['group', 'texturesLeaf']],
    ['a disabled mod and a separator group', ['off', 'pack']],
  ])('Space, Delete and F2 do nothing over %s, either of which may be the focused row', async (_case, selection) => {
    const { keysOver } = await shownWithEveryRowKind();

    expect(keysOver(...selection)).toMatchObject({ selectionToggle: undefined, selectionKind: undefined });
  });

  it('F2 and a singular gesture see whether exactly one row is selected', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([keysOver('group').singleRow, keysOver('group', 'other').singleRow, keysOver().singleRow]).toEqual([true, false, false]);
  });

  it('go to mod sees exactly one selected file that is in a file order conflict', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([
      keysOver('winning').singleGoToModRow, keysOver('losing').singleGoToModRow, keysOver('alone').singleGoToModRow,
      keysOver('winning', 'alone').singleGoToModRow, keysOver('on').singleGoToModRow, keysOver().singleGoToModRow,
    ]).toEqual([true, true, false, false, false, false]);
  });

  it('compare file sees exactly one selected file row that loses its file order conflict', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([
      keysOver('losing').singleCompareFileRow, keysOver('winning').singleCompareFileRow,
      keysOver('losing', 'winning').singleCompareFileRow, keysOver('on').singleCompareFileRow,
    ]).toEqual([true, false, false, false]);
  });

  it('open source sees exactly one selected mod that holds a repository', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([
      keysOver('source').singleOpenSourceRow, keysOver('on').singleOpenSourceRow, keysOver('source', 'on').singleOpenSourceRow, keysOver('group').singleOpenSourceRow,
    ]).toEqual([true, false, false, false]);
  });

  it('open folder sees exactly one selected row it takes: a mod, Overwrite, a file or a folder', async () => {
    const { keysOver } = await shownWithEveryRowKind();

    expect([
      keysOver('textures').singleOpenFolderRow, keysOver('on').singleOpenFolderRow, keysOver('overwrite').singleOpenFolderRow, keysOver('texturesLeaf').singleOpenFolderRow,
      keysOver('group').singleOpenFolderRow, keysOver('on', 'texturesLeaf').singleOpenFolderRow, keysOver().singleOpenFolderRow,
    ]).toEqual([true, true, true, true, false, false, false]);
  });

  it('enable sees a selected disabled mod, and disable a selected enabled one, read as they are now', async () => {
    const { keysOver, instance, view, rows } = await shownWithEveryRowKind();
    const held = (keys: Record<string, unknown>) => [keys.holdsEnabledMod, keys.holdsDisabledMod];

    expect([held(keysOver('on', 'group')), held(keysOver('off')), held(keysOver('on', 'off')), held(keysOver('group'))])
      .toEqual([[true, false], [false, true], [true, true], [false, false]]);
    view.selectRows([rows.on]);
    instance.publish({ ...instance.value, mods: ENTRIES.map((entry) => (entry.name === 'On' ? mod('On', false) : entry)) });
    expect([seen.contextKeys.get('modbench.mod.holdsEnabledMod'), seen.contextKeys.get('modbench.mod.holdsDisabledMod')]).toEqual([false, true]);
  });

  it('exclude sees a selected file whose own name has no mark, and include one whose own name has, whatever its folder', async () => {
    const { keysOver } = await shownWithEveryRowKind();
    const held = (keys: Record<string, unknown>) => [keys.holdsIncludedFile, keys.holdsExcludedFile];

    expect([
      held(keysOver('alone', 'group')), held(keysOver('excluded')), held(keysOver('alone', 'excluded')),
      held(keysOver('plainInFolder', 'on')), held(keysOver('markedInFolder')),
    ]).toEqual([[true, false], [false, true], [true, true], [true, false], [false, true]]);
  });

  it('unignore sees a selected file the manifest ignores by an entry of its own path, and ignore one it does not ignore', async () => {
    const { keysOver } = await shownWithEveryRowKind();
    const held = (keys: Record<string, unknown>) => [keys.holdsIgnoreEntryFile, keys.holdsUnignoredFile];

    expect([held(keysOver('alone')), held(keysOver('entry')), held(keysOver('under')), held(keysOver('alone', 'entry'))])
      .toEqual([[false, true], [true, false], [false, false], [true, true]]);
  });
});
