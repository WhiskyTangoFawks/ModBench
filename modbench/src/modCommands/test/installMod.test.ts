import { describe, it, expect, vi } from 'vitest';
import { modCommands, type ModPackage } from '../modCommands';
import type { DownloadedFile, DownloadMeta, InstallPackage, InstallTarget } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import type { ModStatus } from '../../client';
import type { ReadModStatus } from '../../client';
import type { ReadFailed } from '../../wire/readFailed';
import { unreadStatus } from '../../test/unreadStatus';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const MOD = 'Freshly Installed Mod';
const ARCHIVE: InstallPackage = { kind: 'archive', path: '/elsewhere/Freshly-1-0.7z' };
const NEW_MOD: InstallTarget = { kind: 'new', name: MOD };
const UPGRADED = { kind: 'upgrade', name: 'Harder VATS' } as const;
const DOWNLOADED = { kind: 'downloadedFile', name: 'Freshly-1-0.7z' } as const;
const DOWNLOADED_PATH = '/downloads/Freshly-1-0.7z';
const downloadedFile = (name: string, path: string, meta?: Partial<DownloadMeta>): DownloadedFile =>
  ({ name, path, metaPath: `${path}.meta`, size: 1, mtimeMs: 1, meta: meta && { status: 'Downloaded', excluded: false, ...meta } });
const FRESHLY = downloadedFile(DOWNLOADED.name, DOWNLOADED_PATH, { modID: '111', fileID: '222', version: '3.0.0' });

function install(
  installed: ModPackage, target: InstallTarget = NEW_MOD, answers: InstanceAnswers = {}, force = true, readStatus: ReadModStatus = unreadStatus,
  files: readonly DownloadedFile[] = [FRESHLY],
) {
  const fake = fakeInstanceAdapter(readingFixture({ downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files } }), answers);
  const outcome = modCommands(fake.adapter, new InMemoryMEditClient(), readStatus).installMod(installed, target, force);
  return outcome.then((result) => ({ result, calls: fake.calls }));
}

const statusOf = (over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod: UPGRADED.name, noManifest: false, differing: [], namedByNoLine: [], gone: [], notInPackage: [], metadataDiffers: false, noHost: false, ...over });

const reading = (answer: readonly ModStatus[] | ReadFailed) => vi.fn<ReadModStatus>().mockResolvedValue(answer);

describe('installMod', () => {
  describe('an upgrade without force', () => {
    it.each<[string, Partial<ModStatus>, string]>([
      ['differs from its manifest', { differing: ['a.esp'] }, 'files whose bytes differ from its manifest: a.esp'],
      ['holds a file no line names', { namedByNoLine: ['stray.txt'] }, 'files no line of its manifest names: stray.txt'],
      ['lacks a file its manifest names', { gone: ['b.nif'] }, 'files its manifest names that its folder lacks: b.nif'],
      ['has no manifest', { noManifest: true }, 'it has no manifest'],
      ['has a file its package does not hold', { notInPackage: ['c.dds'] }, 'files its package does not hold: c.dds'],
    ])('refuses a mod that %s, listing the loss and naming force, and installs nothing', async (_, over, loss) => {
      const { result, calls } = await install(ARCHIVE, UPGRADED, {}, false, reading([statusOf(over)]));

      expect(result).toEqual({
        applied: false,
        refusal: `The upgrade would lose, in "Harder VATS": ${loss}. Request it again with force to replace its files.`,
      });
      expect(calls).toEqual([]);
    });

    it.each<[string, ModStatus[] | ReadFailed, string]>([
      ['a status read that failed', { failed: 'unreachable' }, 'mEdit could not be reached'],
      ['a status mEdit could not read', [statusOf({ unreadable: { manifest: true, why: 'bad manifest' } })], 'bad manifest'],
    ])('refuses on %s and installs nothing', async (_, answer, why) => {
      const { result, calls } = await install(ARCHIVE, UPGRADED, {}, false, reading(answer));

      expect(result).toEqual({
        applied: false, refusal: `"Harder VATS" status could not be read: ${why}. Request it again with force to replace its files.`,
      });
      expect(calls).toEqual([]);
    });

    it('asks for the status of the target mod alone', async () => {
      const readStatus = reading([statusOf()]);

      await install(ARCHIVE, UPGRADED, {}, false, readStatus);

      expect(readStatus.mock.calls).toEqual([[['Harder VATS']]]);
    });

    it('refuses a mod with a folder that the status answer leaves out, naming force, and installs nothing', async () => {
      const { result, calls } = await install(ARCHIVE, UPGRADED, {}, false, reading([]));

      expect(result).toEqual({ applied: false, refusal: '"Harder VATS" has no status in the answer. Request it again with force to replace its files.' });
      expect(calls).toEqual([]);
    });

    it('leaves a mod no folder holds to the adapter, whose claim refuses it', async () => {
      const answers = { installed: { landed: false }, foldersAbsent: new Set(['Vanished Mod']) } as const;

      const { result } = await install(ARCHIVE, { kind: 'upgrade', name: 'Vanished Mod' }, answers, false, reading([]));

      expect(result).toEqual({ applied: false, refusal: 'Cannot upgrade "Vanished Mod": there is no folder by that name under mods/.' });
    });

    it('installs over a mod whose status shows nothing to lose', async () => {
      const { result } = await install(ARCHIVE, UPGRADED, {}, false, reading([statusOf()]));

      expect(result).toEqual({ applied: true, isFomod: false });
    });
  });

  it.each([
    ['an upgrade that would lose files, forced', UPGRADED, true],
    ['a new mod, unforced', NEW_MOD, false],
  ] as const)('installs %s, reading no status', async (_, target, force) => {
    const readStatus = reading([statusOf({ noManifest: true })]);

    const { result } = await install(ARCHIVE, target, {}, force, readStatus);

    expect(result).toEqual({ applied: true, isFomod: false });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['a new mod whose name a folder holds, in the words create empty mod uses', { kind: 'new', name: 'Harder VATS' }, 'A mod named "Harder VATS" already exists — install its next release from the Downloads view instead.'],
    ['an upgrade of a mod no folder holds', { kind: 'upgrade', name: 'Vanished Mod' }, 'Cannot upgrade "Vanished Mod": there is no folder by that name under mods/.'],
  ] as const)('refuses %s when the adapter lands nothing', async (_, target, refusal) => {
    const { result } = await install(ARCHIVE, target, { installed: { landed: false } });

    expect(result).toEqual({ applied: false, refusal });
  });

  it('refuses a new mod named by blanks and installs nothing', async () => {
    const { result, calls } = await install(ARCHIVE, { kind: 'new', name: '  ' });

    expect(result).toEqual({ applied: false, refusal: 'A mod name cannot be empty.' });
    expect(calls).toEqual([]);
  });

  it('refuses with why the adapter failed', async () => {
    const { result } = await install(ARCHIVE, NEW_MOD, { refusals: refusing('install', 'archive is corrupt') });

    expect(result).toEqual({ applied: false, refusal: 'archive is corrupt' });
  });

  it('says whether the package is a scripted installer, as the adapter found', async () => {
    const { result } = await install(ARCHIVE, NEW_MOD, { installed: { landed: true, isFomod: true } });

    expect(result).toEqual({ applied: true, isFomod: true });
  });

  it.each([
    ['a folder', { kind: 'folder', path: '/elsewhere/Loose' }, { kind: 'folder', path: '/elsewhere/Loose' }, {}],
    ['an archive, recording its file name', ARCHIVE, ARCHIVE, { archiveFilename: 'Freshly-1-0.7z' }],
    ['a downloaded file, recording its name, Nexus ids and version', DOWNLOADED, { kind: 'archive', path: DOWNLOADED_PATH },
      { archiveFilename: 'Freshly-1-0.7z', nexusId: '111', version: '3.0.0', installedFiles: [{ nexusId: '111', fileId: '222' }] }],
    ['an archive that is a downloaded file, recording what the file\'s metadata holds', { kind: 'archive', path: DOWNLOADED_PATH }, { kind: 'archive', path: DOWNLOADED_PATH },
      { archiveFilename: 'Freshly-1-0.7z', nexusId: '111', version: '3.0.0', installedFiles: [{ nexusId: '111', fileId: '222' }] }],
  ] as const)('hands the adapter %s with the keys its meta is to hold', async (_, installed, handed, keys) => {
    const { calls } = await install(installed);

    expect(calls[0]).toEqual({ verb: 'install', package: handed, target: NEW_MOD, keys });
  });

  it('records no Nexus id for a downloaded file whose metadata holds none', async () => {
    const { calls } = await install(DOWNLOADED, NEW_MOD, {}, true, unreadStatus, [downloadedFile(DOWNLOADED.name, DOWNLOADED_PATH)]);

    expect(calls[0]).toMatchObject({ verb: 'install', keys: { archiveFilename: 'Freshly-1-0.7z', nexusId: undefined, installedFiles: undefined } });
  });

  it('marks a downloaded file installed once it landed, and marks no file for an archive, though a downloaded file bears its name', async () => {
    expect((await install(DOWNLOADED)).calls.map((call) => call.verb)).toEqual(['install', 'markDownloadedFile']);
    expect((await install(DOWNLOADED)).calls[1]).toEqual({ verb: 'markDownloadedFile', name: DOWNLOADED.name, mark: 'Installed' });
    expect((await install({ kind: 'archive', path: DOWNLOADED_PATH })).calls[1]).toEqual({ verb: 'markDownloadedFile', name: DOWNLOADED.name, mark: 'Installed' });
    expect((await install({ kind: 'archive', path: '/elsewhere/Freshly-1-0.7z' })).calls.map((call) => call.verb)).toEqual(['install']);
  });

  it('refuses a downloaded file the downloads folder lacks, installing nothing', async () => {
    const { result, calls } = await install(DOWNLOADED, NEW_MOD, {}, true, unreadStatus, []);

    expect(result).toEqual({ applied: false, refusal: '"Freshly-1-0.7z" is gone from Downloads.' });
    expect(calls).toEqual([]);
  });

  it('refuses, installing nothing, when the downloaded files cannot be read', async () => {
    const { result, calls } = await install(ARCHIVE, NEW_MOD, { unreadReads: { downloadedFiles: 'downloads is locked' } });

    expect(result).toEqual({ applied: false, refusal: 'downloads is locked' });
    expect(calls).toEqual([]);
  });

  it('marks no downloaded file when nothing landed', async () => {
    const { calls } = await install(DOWNLOADED, NEW_MOD, { installed: { landed: false } });

    expect(calls.map((call) => call.verb)).toEqual(['install']);
  });

  it.each([
    ['its metadata cannot be written', { refusals: refusing('markDownloadedFile', 'EISDIR: illegal operation on a directory') }, /EISDIR/],
    ['it is gone from disk', { goneDownloads: new Set([DOWNLOADED.name]) }, /"Freshly-1-0.7z" is gone from disk/],
  ] as const)('reports a downloaded file it could not mark, because %s, beside the landed mod', async (_, answers, why) => {
    const { result } = await install(DOWNLOADED, NEW_MOD, answers);

    expect(result).toMatchObject({ applied: true, isFomod: false });
    expect(result.applied && result.downloadedFileRefusal).toMatch(why);
  });
});
