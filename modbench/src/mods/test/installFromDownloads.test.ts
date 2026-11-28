import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { installs, modsViewOn } from './modsViewOn';
import { answers, seen } from './modsVscode';
import { progressSteps } from '../../test/recordedProgress';
import type { DownloadedFileRow, LocatedDownloadedFileRow, UpgradeCandidate } from '../../instanceLoader/instance';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { downloadedFilesOf, fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';

type View = ReturnType<typeof modsViewOn>;
type Choose = (items: readonly { label: string }[]) => { label: string } | undefined;

const viewListing = (listed: readonly LocatedDownloadedFileRow[], answered: InstanceAnswers = {}) => {
  const reporters = new Map<string, RecordingReporter>();
  const under = (tag: string): RecordingReporter => reporters.get(tag) ?? present(reporters.set(tag, recordingReporter()).get(tag), tag);
  const view = modsViewOn({
    value: instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: [...listed] } }),
    adapter: fakeInstanceAdapter(readingFixture({ modFolders: modFoldersOf('Harder VATS'), downloadedFiles: downloadedFilesOf('foo.7z') }), answered),
    reporterFor: under,
  });
  return { ...view, under };
};

const installFrom = (view: View, file: LocatedDownloadedFileRow) => view.run('modbench.mod.install', { argument: { kind: 'downloadedFile', row: file } });

async function installed(file: LocatedDownloadedFileRow, listed: readonly LocatedDownloadedFileRow[], answered: InstanceAnswers = {}, pick?: Choose) {
  const view = viewListing(listed, answered);
  answers.inputBox = (options) => options.value;
  if (pick) answers.createdQuickPick = pick;
  await installFrom(view, file);
  return view;
}

const installRow = (row: Partial<DownloadedFileRow> = {}, answered: InstanceAnswers = {}, pick?: Choose) => {
  const file = downloadedFileRowFixture('foo.7z', row);
  return installed(file, [file], answered, pick);
};

const FOO = { kind: 'archive', path: '/downloads/foo.7z' };
const ON_THE_PAGE = { kind: 'dialog', dialog: expect.anything() as unknown, steps: [] };
const AS_NEW_MOD = [{ package: FOO, target: { kind: 'new', name: 'foo' }, fomod: ON_THE_PAGE }];
const AS_UPGRADE = [{ package: FOO, target: { kind: 'upgrade', name: 'Harder VATS' }, fomod: ON_THE_PAGE }];

const stepOnInstall: InstanceAnswers['refusals'] = (call) => {
  if (call.verb === 'install') progressSteps.push('install');
  return undefined;
};

describe('modbench.mod.install over a downloaded file', () => {
  it('install: a failed mark installed is one Output line and no failure notification', async () => {
    const { lines, under } = await installRow({}, { refusals: refusing('markDownloadedFile', 'EISDIR: illegal operation on a directory') });

    expect(lines).toEqual(['[downloadedFiles] "foo.7z" was installed, but its Downloads status could not be updated: EISDIR: illegal operation on a directory']);
    expect([under('downloadedFiles').reports, under('downloadedFiles').shownFailures]).toEqual([[], []]);
  });

  it('install: a refusal from install surfaces an error', async () => {
    const { under } = await installRow({}, { refusals: refusing('install', 'boom') });

    expect(under('downloadedFiles').reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'boom' }]);
  });
});

const ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE = { modID: '111' };

const NEW_MOD_ITEM = { label: 'Install as a new mod…', choice: { kind: 'new' } };

describe('modbench.mod.install over a downloaded file: the pick among the upgrades the Instance value lists', () => {
  const picking = (upgrades: readonly UpgradeCandidate[], label?: string) =>
    installRow({ ...ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE, upgrades }, {}, (items) => items.find((item) => item.label === label));
  const shownPick = () => present(seen.createdQuickPicks.at(-1), 'the upgrade pick');

  it('shows one row per upgrade, in the listed order, plus a trailing new-mod row, and pre-selects the file-id match', async () => {
    await picking([{ modName: 'The Match', version: '2.0', tier: 'fileId' }, { modName: 'No Match', version: '1.0' }]);

    const theMatch = { label: 'The Match (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'The Match' } };
    expect(shownPick().items).toEqual([
      theMatch,
      { label: 'No Match (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'No Match' } },
      NEW_MOD_ITEM,
    ]);
    expect(shownPick().activeItems).toEqual([theMatch]);
  });

  it('labels an installationFileName match "Installed from this file" and pre-selects it', async () => {
    await picking([{ modName: 'Harder VATS', version: '1.0', tier: 'installationFileName' }]);

    const item = { label: 'Harder VATS (v1.0)', description: 'Installed from this file', choice: { kind: 'upgrade', name: 'Harder VATS' } };
    expect(shownPick().items).toEqual([item, NEW_MOD_ITEM]);
    expect(shownPick().activeItems).toEqual([item]);
  });

  it('pre-selects "Install as a new mod…" when no upgrade carries a tier', async () => {
    await picking([{ modName: 'Some Mod', version: '1.0' }]);

    expect(shownPick().items).toEqual([
      { label: 'Some Mod (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'Some Mod' } },
      NEW_MOD_ITEM,
    ]);
    expect(shownPick().activeItems).toEqual([NEW_MOD_ITEM]);
  });

  it('choosing an upgrade installs over that mod, asking no name (mods.md, What install does, story 3)', async () => {
    const view = await picking([{ modName: 'Harder VATS', version: '1.0' }], 'Harder VATS (v1.0)');

    expect(installs(view)).toEqual(AS_UPGRADE);
    expect(seen.inputBoxes).toEqual([]);
  });

  it('choosing "Install as a new mod…" installs a new mod named after the file', async () => {
    const view = await picking([{ modName: 'Harder VATS', version: '1.0' }], NEW_MOD_ITEM.label);

    expect(installs(view)).toEqual(AS_NEW_MOD);
  });

  it('Esc installs nothing', async () => {
    const { adapter } = await picking([{ modName: 'Harder VATS', version: '1.0' }]);

    expect(adapter.calls).toEqual([]);
  });

  it('refuses a file the Instance value does not list, naming it', async () => {
    const { adapter, under } = await installed(downloadedFileRowFixture('foo.7z'), []);

    expect(adapter.calls).toEqual([]);
    expect(under('downloadedFiles').reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: '"foo.7z" is gone from Downloads.' }]);
  });

  it('a listed file with no upgrades shows no pick and installs as a new mod named after it', async () => {
    const view = await installRow();

    expect(installs(view)).toEqual(AS_NEW_MOD);
    expect(seen.createdQuickPicks).toEqual([]);
  });
});

describe('modbench.mod.install over a downloaded file: the progress bar and the read', () => {
  it('install over a downloaded file installs, then the read, then the bar closes', async () => {
    await installRow({}, { refusals: stepOnInstall });

    expect(progressSteps).toEqual(['progress opens on modbench.downloads', 'install', 'progress closes']);
  });

  it('Esc at the upgrade pick opens no bar', async () => {
    await installRow({ ...ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE, upgrades: [{ modName: 'Foo Mod', version: '1.0' }] });

    expect([seen.createdQuickPicks.length, progressSteps]).toEqual([1, []]);
  });

  it('declining to name the mod installs nothing and opens no bar', async () => {
    const file = downloadedFileRowFixture('foo.7z');
    const view = viewListing([file]);

    await installFrom(view, file);

    expect([seen.inputBoxes.length, view.adapter.calls, progressSteps]).toEqual([1, [], []]);
  });
});
