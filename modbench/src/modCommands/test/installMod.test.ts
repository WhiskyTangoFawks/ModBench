import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modCommands, type ModPackage } from '../modCommands';
import type { DownloadedFile, DownloadedFileMeta, InstallPackage, InstallTarget } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersIn, readingFixture, refusing, repositoriesOf, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';

const MOD = 'Freshly Installed Mod';
const INSTALLATION_FILE: InstallPackage = { kind: 'archive', path: '/elsewhere/Freshly-1-0.7z' };
const NEW_MOD: InstallTarget = { kind: 'new', name: MOD };
const UPGRADED = { kind: 'upgrade', name: 'Harder VATS' } as const;
const DOWNLOADED_FILE = { kind: 'downloadedFile', name: 'Freshly-1-0.7z' } as const;
const DOWNLOADED_FILE_PATH = '/downloads/Freshly-1-0.7z';
const downloadedFile = (name: string, path: string, meta?: Partial<DownloadedFileMeta>): DownloadedFile =>
  ({ name, path, metadataPath: `${path}.meta`, size: 1, mtimeMs: 1, excluded: false, meta: meta && { status: 'Downloaded', ...meta } });
const FRESHLY = downloadedFile(DOWNLOADED_FILE.name, DOWNLOADED_FILE_PATH, { modID: '111', installedKey: '111:222', version: '3.0.0' });

const NO_TRASH = (path: string): Promise<void> => Promise.reject(new Error(`the fake adapter trashes nothing: ${path}`));

let mods: string;

beforeEach(async () => {
  mods = await mkdtemp(join(tmpdir(), 'modbench-install-'));
});
afterEach(async () => {
  await rm(mods, { recursive: true, force: true });
});

function install(
  installed: ModPackage, target: InstallTarget = NEW_MOD, answers: InstanceAnswers = {},
  files: readonly DownloadedFile[] = [FRESHLY], folders: readonly string[] = [UPGRADED.name],
) {
  const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(mods, ...folders), downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files } }), answers);
  const outcome = modCommands(fake.adapter).installMod(installed, target, NO_TRASH);
  return outcome.then((result) => ({ result, calls: fake.calls }));
}

describe('installMod', () => {
  it('refuses a source mod as the mod to upgrade, naming its build file, and installs nothing', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(mods, UPGRADED.name), sourceRepositories: repositoriesOf({ [UPGRADED.name]: '/source/vats' }) }));

    const result = await modCommands(fake.adapter).installMod(INSTALLATION_FILE, UPGRADED, NO_TRASH);

    expect(result).toEqual({
      applied: false,
      refusal: 'Cannot upgrade "Harder VATS": it is a source mod, and its next build overwrites what an upgrade writes. Change its build.json instead.',
    });
    expect(fake.calls).toEqual([]);
  });

  it.each([['an upgrade over a mod with no manifest', UPGRADED], ['a new mod', NEW_MOD]] as const)('installs %s, asking nothing', async (_, target) => {
    const { result } = await install(INSTALLATION_FILE, target);

    expect(result).toEqual({ applied: true });
  });

  it.each([
    ['a new mod whose name a folder holds, in the words create empty mod uses', { kind: 'new', name: 'Harder VATS' }, 'A mod named "Harder VATS" already exists. Install its next release from Downloads, or uninstall it to install anew.'],
    ['an upgrade of a mod no folder holds', { kind: 'upgrade', name: 'Vanished Mod' }, 'Cannot upgrade "Vanished Mod": there is no folder by that name under mods/.'],
  ] as const)('refuses %s when the adapter lands nothing', async (_, target, refusal) => {
    const { result } = await install(INSTALLATION_FILE, target, { installed: { landed: false } });

    expect(result).toEqual({ applied: false, refusal });
  });

  it('lists no line and refuses nothing for an install the user cancelled', async () => {
    const { result, calls } = await install(INSTALLATION_FILE, NEW_MOD, { installed: { landed: false, cancelled: true } });

    expect(result).toEqual({ applied: true, cancelled: true });
    expect(calls.map((call) => call.verb)).toEqual(['install']);
  });

  it('refuses a new mod named by blanks and installs nothing', async () => {
    const { result, calls } = await install(INSTALLATION_FILE, { kind: 'new', name: '  ' });

    expect(result).toEqual({ applied: false, refusal: 'A mod name cannot be empty.' });
    expect(calls).toEqual([]);
  });

  it('lists a new mod in mod order before it ends, so the read after it holds the mod', async () => {
    const { result, calls } = await install(INSTALLATION_FILE, NEW_MOD);

    expect(result).toEqual({ applied: true });
    expect(calls.map((call) => call.verb)).toEqual(['install', 'changeModOrder']);
    expect(calls[1]).toMatchObject({ changes: [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: MOD } }] });
  });

  it('lands the mod carrying why its line could not be written', async () => {
    const { result } = await install(INSTALLATION_FILE, NEW_MOD, { refusals: refusing('changeModOrder', 'modlist.txt is locked') });

    expect(result).toEqual({ applied: true, lineRefusal: 'modlist.txt is locked' });
  });

  it('refuses with why the adapter failed', async () => {
    const { result } = await install(INSTALLATION_FILE, NEW_MOD, { refusals: refusing('install', 'archive is corrupt') });

    expect(result).toEqual({ applied: false, refusal: 'archive is corrupt' });
  });

  it('says how a FOMOD landed, as the adapter found', async () => {
    const fomod = { kind: 'installer', missing: ['gone.esp'], notes: [] } as const;
    const { result } = await install(INSTALLATION_FILE, NEW_MOD, { installed: { landed: true, fomod } });

    expect(result).toEqual({ applied: true, fomod });
  });

  it.each([
    ['a folder', { kind: 'folder', path: '/elsewhere/Loose' }, { kind: 'folder', path: '/elsewhere/Loose' }, {}],
    ['an installation file, recording its file name', INSTALLATION_FILE, INSTALLATION_FILE, { installationFileName: 'Freshly-1-0.7z' }],
    ['a downloaded file, recording its name, Nexus ids and version', DOWNLOADED_FILE, { kind: 'archive', path: DOWNLOADED_FILE_PATH },
      { installationFileName: 'Freshly-1-0.7z', nexusId: '111', version: '3.0.0', installedFileKeys: ['111:222'] }],
    ['an archive that is a downloaded file, recording what the file\'s metadata holds', { kind: 'archive', path: DOWNLOADED_FILE_PATH }, { kind: 'archive', path: DOWNLOADED_FILE_PATH },
      { installationFileName: 'Freshly-1-0.7z', nexusId: '111', version: '3.0.0', installedFileKeys: ['111:222'] }],
  ] as const)('hands the adapter %s with the keys its meta is to hold', async (_, installed, handed, keys) => {
    const { calls } = await install(installed);

    expect(calls[0]).toEqual({ verb: 'install', package: handed, target: NEW_MOD, keys });
  });

  it.each([
    ['the metadata records', { fileCategory: 3 }, 3],
    ['the metadata records none', {}, undefined],
    ['there is no metadata', undefined, undefined],
  ])('records the Nexus file status when %s', async (_, meta, expected) => {
    const file = downloadedFile(DOWNLOADED_FILE.name, DOWNLOADED_FILE_PATH, meta);

    const { calls } = await install(DOWNLOADED_FILE, NEW_MOD, {}, [file]);

    expect(calls[0]).toMatchObject({ verb: 'install', keys: { nexusFileStatus: expected } });
  });

  it('records no Nexus id for a downloaded file whose metadata holds none', async () => {
    const { calls } = await install(DOWNLOADED_FILE, NEW_MOD, {}, [downloadedFile(DOWNLOADED_FILE.name, DOWNLOADED_FILE_PATH)]);

    expect(calls[0]).toMatchObject({ verb: 'install', keys: { installationFileName: 'Freshly-1-0.7z', nexusId: undefined, installedFileKeys: undefined } });
  });

  const MARKED: AdapterCall = { verb: 'markDownloadedFile', name: DOWNLOADED_FILE.name, mark: 'Installed' };

  it.each<[string, ModPackage, AdapterCall['verb'][], AdapterCall | undefined]>([
    ['marks a downloaded file installed once it landed', DOWNLOADED_FILE, ['install', 'changeModOrder', 'markDownloadedFile'], MARKED],
    ['marks a downloaded file installed for an archive at its path', { kind: 'archive', path: DOWNLOADED_FILE_PATH }, ['install', 'changeModOrder', 'markDownloadedFile'], MARKED],
    ['marks no file for an installation file elsewhere, though a downloaded file bears its name', INSTALLATION_FILE, ['install', 'changeModOrder'], undefined],
  ])('%s', async (_case, installed, verbs, mark) => {
    const { calls } = await install(installed);

    expect([calls.map((call) => call.verb), calls[2]]).toEqual([verbs, mark]);
  });

  it('refuses a downloaded file the downloads folder lacks, installing nothing', async () => {
    const { result, calls } = await install(DOWNLOADED_FILE, NEW_MOD, {}, []);

    expect(result).toEqual({ applied: false, refusal: '"Freshly-1-0.7z" is gone from Downloads.' });
    expect(calls).toEqual([]);
  });

  it('refuses, installing nothing, when the downloaded files cannot be read', async () => {
    const { result, calls } = await install(INSTALLATION_FILE, NEW_MOD, { unreadReads: { downloadedFiles: 'downloaded files are locked' } });

    expect(result).toEqual({ applied: false, refusal: 'downloaded files are locked' });
    expect(calls).toEqual([]);
  });

  it('refuses, installing nothing, an installation file when the downloads folder cannot be resolved', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ downloadedFiles: { kind: 'unresolved', reason: 'the downloads folder is unresolvable' } }));

    const result = await modCommands(fake.adapter).installMod(INSTALLATION_FILE, NEW_MOD, NO_TRASH);

    expect(result).toEqual({ applied: false, refusal: 'the downloads folder is unresolvable' });
    expect(fake.calls).toEqual([]);
  });

  it.each(['a/b', 'a\\b', '.', '..'])('refuses the new mod name %s, installing nothing', async (name) => {
    const { result, calls } = await install(DOWNLOADED_FILE, { kind: 'new', name });

    expect(result).toEqual({ applied: false, refusal: 'A name cannot be . or .. or contain / or \\' });
    expect(calls).toEqual([]);
  });

  it('marks no downloaded file when nothing landed', async () => {
    const { calls } = await install(DOWNLOADED_FILE, NEW_MOD, { installed: { landed: false } });

    expect(calls.map((call) => call.verb)).toEqual(['install']);
  });

  it('reports a downloaded file it could not mark, because its metadata cannot be written, beside the landed mod', async () => {
    const { result } = await install(DOWNLOADED_FILE, NEW_MOD, { refusals: refusing('markDownloadedFile', 'EISDIR: illegal operation on a directory') });

    expect(result).toEqual({ applied: true, downloadedFile: 'Freshly-1-0.7z', downloadedFileRefusal: 'EISDIR: illegal operation on a directory' });
  });

  it('reports a downloaded file it could not mark, because it went from disk during the install, beside the landed mod', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files: [FRESHLY] } }), {
      refusals: (call) => {
        if (call.verb === 'install') fake.read({ downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files: [] } });
        return undefined;
      },
    });

    const result = await modCommands(fake.adapter).installMod(DOWNLOADED_FILE, NEW_MOD, NO_TRASH);

    expect(result).toEqual({ applied: true, downloadedFile: 'Freshly-1-0.7z', downloadedFileRefusal: '"Freshly-1-0.7z" is gone from disk.' });
  });
});
