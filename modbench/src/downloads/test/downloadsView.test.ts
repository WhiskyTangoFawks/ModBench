import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { TreeItemCollapsibleState, ThemeIcon, ThemeColor, Uri, FakeCancellationToken } from '../../test/vscodeMock';

vi.mock('vscode', async () => (await import('./downloadsVscode')).downloadsVscode());

import { clearRegistered, createQuickPick, registered } from './downloadsVscode';
import {
  DOWNLOADS_DIR, command, currentBox, downloadsTree, everyRow, instanceListing, namesShown, rowNamed, rowsShown, valueListing, viewOver,
} from './downloadsViewHarness';
import { DOWNLOADS_KEY_ARGS } from '../keyContext';
import type { DownloadedFileRow, InstanceValue, LocatedDownloadedFileRow } from '../../instanceLoader/instance';
import { ErrorNode } from '../../drivingLib/errorNode';
import { present } from '../../ports/present';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { tagRecordingReporterFor } from '../../test/surfacingDoubles';
import { quickPickChoosing } from '../../drivingLib/test/quickPickDouble';
import { settled } from '../../test/eventually';

const row = (name: string, over: Partial<DownloadedFileRow> = {}) => downloadedFileRowFixture(name, over);
const SEQUENCE_NOT_READ_YET = 0;

beforeEach(clearRegistered);

async function drawn(shown: ReturnType<typeof row>) {
  await everyRow(instanceListing(shown));
  return rowNamed(shown.name);
}

describe('the Downloads view is a flat list whose rows select several at once (common.md, story 6; downloads.md)', () => {
  it('selects several rows and has no Collapse All', () => {
    viewOver(instanceListing(row('other.7z')));

    const { canSelectMany, showCollapseAll } = downloadsTree().options;
    expect({ canSelectMany, showCollapseAll }).toEqual({ canSelectMany: true, showCollapseAll: undefined });
  });
});

describe('a downloaded file row', () => {
  it('is labelled with the display name, keeps the file name as its id, and is a leaf', async () => {
    const shown = await drawn(row('foo_1_2_3.zip', { displayName: 'Sleep or Save' }));

    expect(shown).toMatchObject({ label: 'Sleep or Save', id: 'foo_1_2_3.zip', collapsibleState: TreeItemCollapsibleState.None });
    expect(await downloadsTree().treeDataProvider.getChildren(shown)).toEqual([]);
  });

  it.each<[DownloadedFileRow['status'], ThemeIcon]>([
    ['Downloaded', new ThemeIcon('archive', new ThemeColor('charts.green'))],
    ['Installed', new ThemeIcon('check')],
    ['Uninstalled', new ThemeIcon('circle-slash', new ThemeColor('charts.yellow'))],
  ])('shows the status of a %s file by its icon and colour', async (status, icon) => {
    expect(await drawn(row('foo.zip', { status }))).toMatchObject({ iconPath: icon });
  });

  it.each<[string, DownloadedFileRow['status'], string | undefined, string]>([
    ['a Downloaded file appends the status word after the version', 'Downloaded', '2.2.1', 'v2.2.1 Downloaded'],
    ['an Installed file appends the status word after the version', 'Installed', '2.2.1', 'v2.2.1 Installed'],
    ['an Uninstalled file appends the status word after the version', 'Uninstalled', '2.2.1', 'v2.2.1 Uninstalled'],
    ['a Downloaded file with no version shows just the status word', 'Downloaded', undefined, 'Downloaded'],
    ['an Installed file with no version shows just the status word', 'Installed', undefined, 'Installed'],
  ])('description: %s', async (_case, status, version, description) => {
    expect(await drawn(row('foo.zip', { status, version }))).toMatchObject({ description });
  });

  describe('tooltip', () => {
    const tooltipShown = async (shown: ReturnType<typeof row>) => {
      const { tooltipOf } = await everyRow(instanceListing(shown));
      const text = present(tooltipOf(shown.name), `the tooltip of ${shown.name}`);
      expect(await rowNamed(shown.name)).toMatchObject({ tooltip: { value: text } });
      return text;
    };

    it('a fully-populated row includes every field', async () => {
      const text = await tooltipShown(row('foo.zip', {
        modName: 'Sleep or Save', version: '2.2.1', modID: '12345', size: 4096,
        mtimeMs: Date.parse('2024-01-15T10:00:00Z'), gameName: 'Fallout4', author: 'SomeAuthor',
      }));

      expect(text).toContain('**foo.zip**');
      expect(text).toContain('Mod: Sleep or Save');
      expect(text).toContain('Version: v2.2.1');
      expect(text).toContain('Nexus ID: 12345');
      expect(text).toContain('Size: 4096');
      expect(text).toContain('Game: Fallout4');
      expect(text).toContain('Author: SomeAuthor');
    });

    it('a minimal row (filename only) omits every optional field', async () => {
      expect(await tooltipShown(row('foo.zip'))).not.toContain('undefined');
    });
  });

  it.each<[string, Partial<DownloadedFileRow>, string]>([
    ['the base "downloadedFile" token alone when no optional flag applies', {}, 'downloadedFile'],
    ['hasModID, hasMeta and excluded, in that order, when all three are set', { hasMeta: true, excluded: true, modID: '12345' }, 'downloadedFile hasModID hasMeta excluded'],
    ['hasFileID, after hasModID, when the metadata holds a file ID', { modID: '12345', fileID: '78' }, 'downloadedFile hasModID hasFileID'],
    ['only hasModID when just modID is present', { modID: '12345' }, 'downloadedFile hasModID'],
    ['only hasMeta when just hasMeta is set, which gates the openMeta menu entry', { hasMeta: true }, 'downloadedFile hasMeta'],
    ['only excluded when just excluded is set', { excluded: true }, 'downloadedFile excluded'],
  ])('offers the menu entries its when clauses match: %s', async (_case, over, contextValue) => {
    expect(await drawn(row('foo.zip', over))).toMatchObject({ contextValue });
  });

  it('carries the path of the file the value names, which the excluded dimming keys off', async () => {
    expect(await drawn(row('foo.zip'))).toMatchObject({ resourceUri: { fsPath: join(DOWNLOADS_DIR, 'foo.zip') } });
  });

  it.each<[string, Partial<DownloadedFileRow>, { nexusModId: string | undefined; gameName: string | undefined }]>([
    ['its metadata\'s mod id and game, for view on Nexus to open the page of', { modID: '123', gameName: 'SkyrimSE' }, { nexusModId: '123', gameName: 'SkyrimSE' }],
    ['no mod id and no game when its metadata names none', {}, { nexusModId: undefined, gameName: undefined }],
  ])('carries %s', async (_case, over, carried) => {
    expect(await drawn(row('foo.zip', over))).toMatchObject(carried);
  });
});

describe('the Downloads rows come from the Instance value', () => {
  it('shows one row per downloaded file, by filetime, newest first', async () => {
    viewOver(instanceListing(row('old.zip', { mtimeMs: 1000 }), row('new.zip', { mtimeMs: 2000 })));

    expect(await namesShown()).toEqual(['new.zip', 'old.zip']);
  });

  it('shows no rows when the Instance value has no downloads', async () => {
    viewOver(instanceListing());

    expect(await rowsShown()).toEqual([]);
  });

  it.each<[string, DownloadedFileRow[], string[]]>([
    ['case-insensitively', [row('ArmorPack.zip'), row('WeaponPack.zip')], ['ArmorPack.zip']],
    ['by the label, not the raw filename, which has no "armor" in it', [row('file-one.zip', { displayName: 'Armor Pack' }), row('file-two.zip', { displayName: 'Weapon Pack' })], ['file-one.zip']],
  ])('narrows to the rows whose label holds the filter text, %s', async (_case, rows, names) => {
    const { nameFilter } = viewOver(instanceListing(...rows.map((each) => row(each.name, each))));

    nameFilter.open();
    currentBox().type('armor');

    expect(await namesShown()).toEqual(names);
  });

  it('hides an excluded file until Show excluded, flagging its row, and again after Hide excluded', async () => {
    viewOver(instanceListing(row('excluded.zip', { excluded: true, mtimeMs: 2 }), row('visible.zip', { mtimeMs: 1 })));
    expect(await namesShown()).toEqual(['visible.zip']);

    await command('modbench.downloadedFile.showExcluded')();
    expect(await rowsShown()).toMatchObject([{ id: 'excluded.zip', contextValue: 'downloadedFile excluded' }, { id: 'visible.zip' }]);

    await command('modbench.downloadedFile.hideExcluded')();
    expect(await namesShown()).toEqual(['visible.zip']);
  });

  it.each<[string, string]>([
    ['Show excluded', 'modbench.downloadedFile.showExcluded'],
    ['a sort picked', 'modbench.downloadedFile.sort'],
  ])('tells VS Code to draw the rows again on %s', async (_case, id) => {
    createQuickPick.mockReturnValue(quickPickChoosing<{ label: string }>((items) => items.find((item) => item.label === 'Name (A to Z)')));
    viewOver(instanceListing());
    await rowsShown();
    const redrawn = vi.fn();
    downloadsTree().treeDataProvider.onDidChangeTreeData?.(redrawn);

    await command(id)();

    expect(redrawn).toHaveBeenCalledTimes(1);
  });

  it('reveals and selects the row of a file it shows, and has none for one it hides', async () => {
    const { nameFilter, show } = viewOver(instanceListing(row('armor.zip'), row('sleep.zip'), row('old.zip', { excluded: true })));
    nameFilter.open();
    currentBox().type('sleep');

    await present(show('sleep.zip'), 'the reveal of sleep.zip')();

    expect([downloadsTree().reveals, show('armor.zip'), show('old.zip')]).toEqual([[{ label: 'sleep.zip', options: { select: true, focus: true } }], undefined, undefined]);
  });
});

describe('the Downloads sort', () => {
  const pickSort = async (label: string | undefined) => {
    const quickPick = quickPickChoosing<{ label: string }>((items) => items.find((item) => item.label === label));
    createQuickPick.mockReturnValueOnce(quickPick);
    await command('modbench.downloadedFile.sort')();
    return quickPick;
  };
  const rows = [
    row('banana.zip', { size: 1, mtimeMs: 3, status: 'Installed' }),
    row('apple.zip', { size: 3, mtimeMs: 1, status: 'Downloaded' }),
    row('cherry.zip', { size: 2, mtimeMs: 2, status: 'Uninstalled' }),
  ];
  const sameLabel = [row('a.zip', { displayName: 'Same' }), row('b.zip', { displayName: 'Same' }), row('c.zip', { displayName: 'Other' })];

  it.each<[string, LocatedDownloadedFileRow[], string, string[]]>([
    ['by name, A to Z', rows, 'Name (A to Z)', ['apple.zip', 'banana.zip', 'cherry.zip']],
    ['by name, Z to A', rows, 'Name (Z to A)', ['cherry.zip', 'banana.zip', 'apple.zip']],
    ['by status, A to Z', rows, 'Download Status (A to Z)', ['apple.zip', 'banana.zip', 'cherry.zip']],
    ['by size, largest first', rows, 'Size (Largest First)', ['apple.zip', 'cherry.zip', 'banana.zip']],
    ['by filetime, oldest first', rows, 'Filetime (Oldest First)', ['apple.zip', 'cherry.zip', 'banana.zip']],
    ['by the label, A to Z, ties keeping their relative order', sameLabel, 'Name (A to Z)', ['c.zip', 'a.zip', 'b.zip']],
    ['by the label, Z to A, ties keeping their relative order', sameLabel, 'Name (Z to A)', ['a.zip', 'b.zip', 'c.zip']],
  ])('orders the rows %s once picked', async (_case, shown, label, names) => {
    viewOver(instanceListing(...shown));

    await pickSort(label);

    expect(await namesShown()).toEqual(names);
  });

  it('leaves the rows as they were when Esc is pressed', async () => {
    viewOver(instanceListing(...rows));

    await pickSort(undefined);

    expect(await namesShown()).toEqual(['banana.zip', 'cherry.zip', 'apple.zip']);
  });

  it.each<[string, () => Promise<unknown>, { label: string }]>([
    ['the option matching the sort last picked', () => pickSort('Size (Smallest First)'), { label: 'Size (Smallest First)' }],
    ['Filetime (Newest First) before any sort is picked', () => Promise.resolve(), { label: 'Filetime (Newest First)' }],
  ])('marks %s', async (_case, sortedBefore, marked) => {
    viewOver(instanceListing());
    await sortedBefore();

    const { activeItems } = await pickSort(undefined);

    expect(activeItems).toMatchObject([marked]);
  });
});

describe('the Downloads view reacts to the Instance, never scans on its own', () => {
  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', async () => {
    const instance = instanceListing();
    viewOver(instance);

    instance.fail('EACCES downloads');
    await settled(() => expect(downloadsTree().message).toBe('Showing the last good read: EACCES downloads'));

    instance.publish(valueListing());
    await settled(() => expect(downloadsTree().message).toBeUndefined());
  });

  it('shows no rows before the first read, and the read\'s rows once it lands', async () => {
    const instance = new FakeInstance(valueListing(), SEQUENCE_NOT_READ_YET);
    viewOver(instance);

    const pending = namesShown();
    instance.publish(valueListing(row('a.zip')));

    expect(await pending).toEqual(['a.zip']);
  });

  it('settles a failed first read, rather than spinning forever, on the one error row naming the reason, then shows rows when a value lands', async () => {
    const instance = new FakeInstance(valueListing(), SEQUENCE_NOT_READ_YET);
    viewOver(instance);

    const pending = rowsShown();
    instance.fail('ENOENT: no such file or directory, open modlist.txt');
    expect(await pending).toEqual([new ErrorNode('ENOENT: no such file or directory, open modlist.txt')]);

    instance.publish(valueListing(row('a.zip')));
    expect(await namesShown()).toEqual(['a.zip']);
  });

  it('shows no rows at once when the first landed value is genuinely empty', async () => {
    viewOver(new FakeInstance(valueListing(), 1));

    expect(await rowsShown()).toEqual([]);
  });

  it('shows the rows of each new landed value', async () => {
    const instance = instanceListing(row('a.zip', { mtimeMs: 2 }));
    viewOver(instance);
    expect(await namesShown()).toEqual(['a.zip']);

    instance.publish(valueListing(row('a.zip', { mtimeMs: 2 }), row('b.zip', { mtimeMs: 1 })));

    expect(await namesShown()).toEqual(['a.zip', 'b.zip']);
  });

  it('follows the Instance no more once disposed', async () => {
    const instance = instanceListing(row('a.zip'));
    const view = viewOver(instance);
    await rowsShown();

    view.dispose();
    instance.publish(valueListing(row('a.zip'), row('b.zip')));

    expect(await namesShown()).toEqual(['a.zip']);
  });
});

describe('a configured downloads folder Modbench cannot resolve shows the "Failed to load:" state', () => {
  const REASON = 'download_directory "D:\\Games\\downloads" could not be resolved: '
    + "Cannot translate Wine drive letter 'D:' in 'D:\\Games\\downloads': only Z: and C: are translated";
  const unresolvedValue = () => instanceValueFixture({ downloadedFiles: { kind: 'unresolved', reason: REASON } });

  it('shows one error row naming the reason, even though the instance read itself landed', async () => {
    viewOver(new FakeInstance(unresolvedValue(), 1));

    expect(await rowsShown()).toEqual([new ErrorNode(REASON)]);
  });

  it('shows only the error row while unresolved, not the a.zip row it showed before', async () => {
    const instance = instanceListing(row('a.zip'));
    viewOver(instance);
    await rowsShown();

    instance.publish(unresolvedValue());

    expect(await rowsShown()).toEqual([new ErrorNode(REASON)]);
  });

  it('shows rows again once a later value resolves the folder', async () => {
    const instance = new FakeInstance(unresolvedValue(), 1);
    viewOver(instance);
    await rowsShown();

    instance.publish(valueListing(row('a.zip')));

    expect(await namesShown()).toEqual(['a.zip']);
  });
});

describe('the Downloads filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const instance = instanceListing(row('other.7z'));
    const { nameFilter: downloadsFilter } = viewOver(instance);
    const downloadsView = downloadsTree();

    downloadsFilter.open();
    currentBox().type('zzznomatch');
    await settled(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));

    instance.publish(valueListing(row('zzznomatch.7z')));
    await settled(() => expect(downloadsView.message).toBeUndefined());

    instance.publish(instanceValueFixture());
    await settled(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));
  });
});

describe('the Downloads filter follows a toggle with no new instance value', () => {
  it('recomputes the no-match message off Show excluded, in both directions', async () => {
    const { nameFilter: downloadsFilter } = viewOver(instanceListing(row('zzznomatch.7z', { excluded: true })));
    const downloadsView = downloadsTree();

    downloadsFilter.open();
    currentBox().type('zzznomatch');
    await settled(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));

    await command('modbench.downloadedFile.showExcluded')();
    await settled(() => expect(downloadsView.message).toBeUndefined());

    await command('modbench.downloadedFile.hideExcluded')();
    await settled(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));
  });
});

describe('the Downloads view sets the all-excluded context key, distinct from no downloads: files exist but Show excluded being off hides every one', () => {
  const KEY = 'modbench.downloadedFile.allExcluded';
  const contextValue = () => registered.contextKeys.get(KEY);

  it.each<[string, InstanceValue, boolean]>([
    ['false with no downloads at all', valueListing(), false],
    ['false while at least one downloaded file is not excluded', valueListing(row('a.7z'), row('b.7z', { excluded: true })), false],
    ['true when every downloaded file is excluded', valueListing(row('a.7z', { excluded: true }), row('b.7z', { excluded: true })), true],
    ['false while the downloads folder is unresolved: there are no rows to be all excluded', instanceValueFixture({ downloadedFiles: { kind: 'unresolved', reason: 'no folder' } }), false],
  ])('is %s', (_case, value, allExcluded) => {
    viewOver(new FakeInstance(value));

    expect(contextValue()).toBe(allExcluded);
  });

  it('is true once the one downloaded file is excluded, and follows Show excluded both ways', async () => {
    viewOver(instanceListing(row('a.7z', { excluded: true })));
    expect(contextValue()).toBe(true);

    await command('modbench.downloadedFile.showExcluded')();
    expect(contextValue()).toBe(false);

    await command('modbench.downloadedFile.hideExcluded')();
    expect(contextValue()).toBe(true);
  });
});

describe('the Downloads view dims the row of an excluded file it shows (colour only, no badge)', () => {
  const DIMMED = { color: new ThemeColor('disabledForeground') };
  const decoration = (uri: vscode.Uri) =>
    present(registered.decorationProviders[0], 'the registered decoration provider').provideFileDecoration(uri, new FakeCancellationToken());
  const inDownloads = (name: string) => Uri.file(join(DOWNLOADS_DIR, name));
  const EXCLUDED = row('excluded.zip', { excluded: true });
  const valueIn = (downloadsDir: string | undefined) =>
    instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: [EXCLUDED] }, paths: { ...instanceValueFixture().paths, downloadsDir } });

  it.each<[string, vscode.Uri, typeof DIMMED | undefined]>([
    ['an excluded file\'s row, dimmed', inDownloads('excluded.zip'), DIMMED],
    ['an included file\'s row, as it is', inDownloads('included.zip'), undefined],
    ['a URI outside the downloads folder, as it is', Uri.file(join('/instance', 'mods', 'SomeMod')), undefined],
    ['a sibling path that only shares the downloads folder\'s string prefix, as it is, though slicing it gives an excluded file\'s name', Uri.file(`${DOWNLOADS_DIR}Xexcluded.zip`), undefined],
  ])('decorates %s', async (_case, uri, decorated) => {
    await everyRow(instanceListing(EXCLUDED, row('included.zip')));
    await rowsShown();

    expect(decoration(uri)).toEqual(decorated);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['before the tree draws its rows', async () => { await command('modbench.downloadedFile.showExcluded')(); }],
    ['while Show excluded is off', () => rowsShown()],
  ])('dims nothing %s', async (_case, shown) => {
    viewOver(instanceListing(EXCLUDED));
    await shown();

    expect(decoration(inDownloads('excluded.zip'))).toBeUndefined();
  });

  it('dims nothing while the downloads folder is unresolved, not even a row under the default downloads folder', async () => {
    await everyRow(new FakeInstance(valueIn(undefined)));
    await rowsShown();

    expect(decoration(inDownloads('excluded.zip'))).toBeUndefined();
  });

  it('dims a row given a backslash-separated Windows path, which a hardcoded / join would not match', async () => {
    await everyRow(new FakeInstance(valueIn(String.raw`C:\Instance\downloads`)));
    await rowsShown();

    expect(decoration(Uri.file(String.raw`C:\Instance\downloads\excluded.zip`))).toEqual(DIMMED);
  });

  it('follows the downloads folder when download_directory moves while Modbench runs', async () => {
    const instance = instanceListing(EXCLUDED);
    await everyRow(instance);
    const moved = join('/instance', 'MovedDownloads');

    instance.publish(valueIn(moved));
    await rowsShown();

    expect(decoration(Uri.file(join(moved, 'excluded.zip')))).toEqual(DIMMED);
  });

  it('tells VS Code the decorations changed once the Instance value carries a new downloaded file', () => {
    const instance = instanceListing();
    viewOver(instance);
    const fired = vi.fn();
    present(registered.decorationProviders[0], 'the registered decoration provider').onDidChangeFileDecorations?.(fired);

    instance.publish(valueListing(row('zzznew.7z')));

    expect(fired).toHaveBeenCalled();
  });
});

describe('the Downloads view tells its palette entries, which are handed no row, what the selection holds', () => {
  const KEYS = ['singleFile', 'singleFileWithMeta', 'holdsFile', 'holdsIncluded', 'holdsExcluded'] as const;
  const NOTHING = { singleFile: false, singleFileWithMeta: false, holdsFile: false, holdsIncluded: false, holdsExcluded: false };
  const keys = () => Object.fromEntries(KEYS.map((name) => [name, registered.contextKeys.get(`modbench.downloadedFile.${name}`)]));

  it.each<[string, string[], typeof NOTHING]>([
    ['one file with no metadata, for open, delete and exclude', ['plain.7z'], { ...NOTHING, singleFile: true, holdsFile: true, holdsIncluded: true }],
    ['one file with metadata, for open metadata too', ['meta.7z'], { ...NOTHING, singleFile: true, singleFileWithMeta: true, holdsFile: true, holdsIncluded: true }],
    ['one excluded file, for include and not exclude', ['excluded.7z'], { ...NOTHING, singleFile: true, singleFileWithMeta: true, holdsFile: true, holdsExcluded: true }],
    ['two files, for neither open', ['plain.7z', 'meta.7z'], { ...NOTHING, holdsFile: true, holdsIncluded: true }],
    ['an included and an excluded file, for exclude and include both', ['plain.7z', 'excluded.7z'], { ...NOTHING, holdsFile: true, holdsIncluded: true, holdsExcluded: true }],
    ['two files with metadata, for no open metadata', ['meta.7z', 'excluded.7z'], { ...NOTHING, holdsFile: true, holdsIncluded: true, holdsExcluded: true }],
    ['nothing selected, for nothing', [], NOTHING],
    ['an error row, which is no file, for nothing', ['an error row'], NOTHING],
  ])('%s', async (_case, selected, context) => {
    await everyRow(instanceListing(row('plain.7z'), row('meta.7z', { hasMeta: true }), row('excluded.7z', { hasMeta: true, excluded: true })));
    const shown = new Map<string, unknown>([
      ['plain.7z', await rowNamed('plain.7z')],
      ['meta.7z', await rowNamed('meta.7z')],
      ['excluded.7z', await rowNamed('excluded.7z')],
      ['an error row', new ErrorNode('unreadable')],
    ]);

    downloadsTree().selectRows(selected.map((name) => shown.get(name)));

    expect(keys()).toEqual(context);
  });
});

describe('the Downloads view\'s own text for the catalog\'s copy value', () => {
  it('is reported under the downloaded file tag', () => {
    expect(viewOver(instanceListing()).copyValue.reporterTag).toBe('downloadedFile.copyValue');
  });

  it('is the file name of a right-clicked row, not its display name', async () => {
    const { copyValue } = viewOver(instanceListing(row('alpha.7z', { displayName: 'Alpha Mod' })));

    expect(copyValue.text(await rowNamed('alpha.7z'), undefined)).toBe('alpha.7z');
  });

  it('is the selection for the view\'s own Ctrl+C, skipping a row that is no file', async () => {
    const { copyValue } = viewOver(instanceListing(row('alpha.7z', { displayName: 'Alpha Mod' })));
    downloadsTree().selectRows([new ErrorNode('unreadable'), await rowNamed('alpha.7z')]);

    expect(copyValue.text(DOWNLOADS_KEY_ARGS, undefined)).toBe('alpha.7z');
  });
});

describe('the Downloads view names its own tags', () => {
  it('reports under the downloadedFiles tag', () => {
    const { reporterFor, tags } = tagRecordingReporterFor();
    viewOver(instanceListing(), { reporterFor });

    expect(tags).toEqual(['downloadedFiles']);
  });
});

describe('the downloads folder unresolved, in the Output', () => {
  it.each<[string, InstanceValue, string[]]>([
    ['is a line naming the reason once the Instance value carries it', instanceValueFixture({ downloadedFiles: { kind: 'unresolved', reason: 'no folder' } }), ['[instance] no folder']],
    ['is no line while the folder is resolved', valueListing(), []],
  ])('%s', (_case, value, lines) => {
    const instance = new FakeInstance(instanceValueFixture());
    const written: string[] = [];
    viewOver(instance, { channel: { warn: (line) => written.push(line) } });

    instance.publish(value);

    expect(written).toEqual(lines);
  });
});
