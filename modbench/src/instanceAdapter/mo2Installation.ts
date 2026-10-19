// What MO2 records of a mod's installation: the downloaded file meta.ini names, and meta.ini itself.

import { entryNamed } from './codecs/modlistText';
import { basename, dirname, isAbsolute } from 'node:path';
import { gameReleaseForNexusDomain, nexusDomainForMetaGame } from '../tables/gamePaths';
import { changeOwnedKeysInText, MOD_META_FILE_NAME, parseMetaIni } from './codecs/metaIni';
import { readGameName } from './codecs/modOrganizerIni';
import { ensureDir, exists, get, readOrReason, withLock, write } from './files';
import type { HashIndex } from './downloadedFileContents/hashIndex';
import type { FileRead, InstalledFileId, InstallationFile, InstanceAdapter, ModMeta, ModMetadata, OwnedMetaKeys } from './instanceAdapter';
import { downloadFile, modMetaFileIn, settingsFile } from './layout';
import { currentDownloadsDir, folderHolding, newModFolder, type Mo2Context } from './mo2Context';
import type { ReadingSource } from './instanceReading';
import { formatNexusPage, parseNexusPage } from './nexusPage';

// MO2 records a file installed from outside the downloads folder by its whole path, and reinstalls from the
// downloads folder by its name once that path is gone.
async function reinstallPath(context: Mo2Context, recorded: string): Promise<string> {
  return isAbsolute(recorded) && (await exists(recorded)) ? recorded : downloadFile(await currentDownloadsDir(context), basename(recorded));
}

// The file a mod's metadata names: the first installed from its Nexus mod, else the first.
const installedFileOf = ({ nexusId, installedFiles = [] }: ModMeta): InstalledFileId | undefined =>
  installedFiles.find((file) => file.nexusId === nexusId) ?? installedFiles[0];

// A mod with no game of its own is the instance's game's.
async function nexusPageOf(meta: ModMeta, { instanceRoot }: Mo2Context): Promise<Pick<InstallationFile, 'page' | 'unpagedGame'>> {
  const file = installedFileOf(meta);
  const modId = file?.nexusId || meta.nexusId;
  if (!modId) return {};
  const game = meta.gameName ?? readGameName(await get(settingsFile(instanceRoot)));
  const domain = nexusDomainForMetaGame(game);
  return domain === undefined ? { unpagedGame: game } : { page: formatNexusPage({ game: domain, modId, fileId: file?.fileId }) };
}

async function metaGameFor(domain: string, { instanceRoot }: Mo2Context): Promise<string | undefined> {
  const instanceGame = readGameName(await get(settingsFile(instanceRoot)));
  return nexusDomainForMetaGame(instanceGame) === domain ? instanceGame : gameReleaseForNexusDomain(domain);
}

type MetadataPlan = { readonly unwritable: string } | { readonly file: string; readonly held: string; readonly changes: Partial<OwnedMetaKeys> };

async function pageChanges(carried: ModMeta, page: string, context: Mo2Context): Promise<Partial<OwnedMetaKeys> | { readonly unwritable: string }> {
  const nexus = parseNexusPage(page);
  if (nexus === undefined) return { unwritable: `its page '${page}' is not a Nexus page, the only host MO2's metadata holds` };
  const gameName = await metaGameFor(nexus.game, context);
  if (gameName === undefined) return { unwritable: `its page names the Nexus game '${nexus.game}', which Modbench has no game for` };
  const carriedFile = installedFileOf(carried);
  const sameFile = nexus.fileId === undefined ? carriedFile === undefined : carriedFile?.fileId === nexus.fileId && carriedFile.nexusId === nexus.modId;
  return {
    ...(carried.gameName !== undefined && nexusDomainForMetaGame(carried.gameName) === nexus.game ? {} : { gameName }),
    ...(nexus.modId === carried.nexusId ? {} : { nexusId: nexus.modId }),
    ...(sameFile ? {} : { installedFiles: nexus.fileId === undefined ? undefined : [{ nexusId: nexus.modId, fileId: nexus.fileId }] }),
  };
}

// MO2 holds one installation file: the one it holds if the manifest names it, else the manifest's first.
async function planMetadata(context: Mo2Context, mod: string, { version, installationFile: chosen }: ModMetadata): Promise<MetadataPlan> {
  const folder = (await folderHolding(context, { kind: 'mod', name: mod }))?.path ?? newModFolder(context, mod);
  const file = modMetaFileIn(folder);
  if (entryNamed(mod).kind === 'separator') return { file, held: '', changes: {} };
  const held = await get(file, '');
  const carried = parseMetaIni(held);
  const heldName = carried.archiveFilename === undefined ? undefined : basename(carried.archiveFilename);
  const changes: Partial<OwnedMetaKeys> = version === undefined || version === carried.version ? {} : { version };
  if (chosen === undefined) return { file, held, changes };
  if (chosen.name !== heldName) Object.assign(changes, { archiveFilename: chosen.name });
  if (chosen.page !== undefined) {
    const fromPage = await pageChanges(carried, chosen.page, context);
    if ('unwritable' in fromPage) return fromPage;
    Object.assign(changes, fromPage);
  } else if (chosen.name !== heldName) {
    Object.assign(changes, {
      ...(carried.nexusId === undefined ? {} : { nexusId: undefined }),
      ...((carried.installedFiles ?? []).length === 0 ? {} : { installedFiles: undefined }),
    });
  }
  return { file, held, changes };
}

async function metadataOf(meta: ModMeta, context: Mo2Context): Promise<ModMetadata> {
  const { archiveFilename } = meta;
  const { page } = await nexusPageOf(meta, context);
  return { version: meta.version, installationFile: archiveFilename === undefined ? undefined : { name: basename(archiveFilename), page } };
}

export function mo2Installation(
  context: Mo2Context, { downloadedFileHash }: Pick<HashIndex, 'downloadedFileHash'>, { modMeta }: Pick<ReadingSource, 'modMeta'>,
): Pick<InstanceAdapter, 'installationFile' | 'downloadedFile' | 'modMetadata' | 'metadataOf' | 'unwritableMetadata' | 'writeModMetadata' | 'metadataFilesInModFolder'> {
  return {
    modMetadata: (mod) => readOrReason(async () => metadataOf(await modMeta(mod, 'list'), context)),

    metadataOf: (meta) => metadataOf(meta, context),

    unwritableMetadata: async (mod, metadata) => {
      const plan = await planMetadata(context, mod, metadata);
      return 'unwritable' in plan ? plan.unwritable : undefined;
    },

    writeModMetadata: (mod, metadata) => withLock(context.instanceRoot, async () => {
      const plan = await planMetadata(context, mod, metadata);
      if ('unwritable' in plan) throw new Error(`the metadata changed after it was found writable: ${plan.unwritable}`);
      if (Reflect.ownKeys(plan.changes).length === 0) return;
      await ensureDir(dirname(plan.file));
      await write(plan.file, changeOwnedKeysInText(plan.held, plan.changes));
    }),

    async installationFile(mod) {
      const meta = await modMeta(mod, 'list');
      const { archiveFilename } = meta;
      if (archiveFilename === undefined) return { kind: 'read', answer: undefined };
      const refused = (why: string): FileRead<InstallationFile | undefined> =>
        ({ kind: 'unreadable', reason: `Modbench cannot tell what ${archiveFilename} installs: ${why}` });
      const located = await readOrReason(() => reinstallPath(context, archiveFilename));
      if (located.kind === 'unreadable') return refused(located.reason);
      const path = located.answer;
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: { path, ...(await nexusPageOf(meta, context)), ...hashed.answer } } : refused(hashed.reason);
    },

    async downloadedFile(name) {
      // A manifest is text from the repository: a name with a folder in it would reach outside the downloads folder.
      if (basename(name) !== name || name === '..') return { kind: 'read', answer: undefined };
      const located = await readOrReason(async () => downloadFile(await currentDownloadsDir(context), name));
      if (located.kind === 'unreadable') return located;
      const path = located.answer;
      if (!(await exists(path))) return { kind: 'read', answer: undefined };
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: { path, ...hashed.answer } } : hashed;
    },

    metadataFilesInModFolder: [MOD_META_FILE_NAME],
  };
}
