// What MO2 records of a mod's installation: the downloaded file meta.ini names, and meta.ini itself.

import { basename, dirname, isAbsolute } from 'node:path';
import { gamePathInfoForRelease, gameReleaseForMetaGame, gameReleaseForNexusDomain } from '../tables/gamePaths';
import { changeOwnedKeysInText, MOD_META_FILE_NAME, parseMetaIni } from './codecs/metaIni';
import { readGameName } from './codecs/modOrganizerIni';
import { ensureDir, exists, get, readOrReason, withLock, write } from './files';
import type { HashIndex } from './hashIndex';
import type { FileRead, InstalledFileId, InstallationFile, InstanceAdapter, ModMeta, ModMetadata, OwnedMetaKeys } from './instanceAdapter';
import { downloadFile, modMetaFileIn, settingsFile } from './layout';
import { currentDownloadsDir, folderHolding, newModFolder, type Mo2Context } from './mo2Context';
import type { ReadingSource } from './mo2Reads';
import { formatNexusSource, parseNexusSource } from './nexusSource';

// MO2 records a file installed from outside the downloads folder by its whole path, and reinstalls from the
// downloads folder by its name once that path is gone.
async function reinstallPath(context: Mo2Context, recorded: string): Promise<string> {
  return isAbsolute(recorded) && (await exists(recorded)) ? recorded : downloadFile(await currentDownloadsDir(context), basename(recorded));
}

// A mod with no game of its own is the instance's game's.
async function nexusSourceOf(
  { gameName, nexusId, installedFiles = [] }: ModMeta, { instanceRoot }: Mo2Context,
): Promise<Pick<InstallationFile, 'source' | 'unsourcedGame'>> {
  if (nexusId === undefined && installedFiles.length === 0) return {};
  const game = gameName ?? readGameName(await get(settingsFile(instanceRoot)));
  const release = gameReleaseForMetaGame(game);
  const domain = release === undefined ? undefined : gamePathInfoForRelease(release)?.nexusSlug;
  return domain === undefined ? { unsourcedGame: game } : { source: formatNexusSource({ game: domain, modId: nexusId, files: installedFiles }) };
}

const sameFiles = (a: readonly InstalledFileId[], b: readonly InstalledFileId[]): boolean =>
  formatNexusSource({ game: '', modId: undefined, files: a }) === formatNexusSource({ game: '', modId: undefined, files: b });

const domainOfGame = (game: string): string | undefined => {
  const release = gameReleaseForMetaGame(game);
  return release === undefined ? undefined : gamePathInfoForRelease(release)?.nexusSlug;
};

async function metaGameFor(domain: string, { instanceRoot }: Mo2Context): Promise<string | undefined> {
  const instanceGame = readGameName(await get(settingsFile(instanceRoot)));
  return domainOfGame(instanceGame) === domain ? instanceGame : gameReleaseForNexusDomain(domain);
}

type MetadataPlan = { readonly unwritable: string } | { readonly file: string; readonly held: string; readonly changes: Partial<OwnedMetaKeys> };

async function sourceChanges(carried: ModMeta, source: string, context: Mo2Context): Promise<Partial<OwnedMetaKeys> | { readonly unwritable: string }> {
  const nexus = parseNexusSource(source);
  if (nexus === undefined) return { unwritable: `its source '${source}' is not a Nexus source, the only one MO2's metadata holds` };
  const gameName = await metaGameFor(nexus.game, context);
  if (gameName === undefined) return { unwritable: `its source names the Nexus game '${nexus.game}', which Modbench has no game for` };
  return {
    ...(carried.gameName !== undefined && domainOfGame(carried.gameName) === nexus.game ? {} : { gameName }),
    ...(nexus.modId === carried.nexusId ? {} : { nexusId: nexus.modId }),
    ...(sameFiles(nexus.files, carried.installedFiles ?? []) ? {} : { installedFiles: nexus.files }),
  };
}

// MO2 holds one installation file: the one it holds if the manifest names it, else the manifest's first.
async function planMetadata(context: Mo2Context, mod: string, { version, installationFiles }: ModMetadata): Promise<MetadataPlan> {
  const folder = (await folderHolding(context, { kind: 'mod', name: mod }))?.path ?? newModFolder(context, mod);
  const file = modMetaFileIn(folder);
  const held = await get(file, '');
  const carried = parseMetaIni(held);
  const heldName = carried.archiveFilename === undefined ? undefined : basename(carried.archiveFilename);
  const chosen = installationFiles.find((candidate) => candidate.name === heldName) ?? installationFiles[0];
  const changes: Partial<OwnedMetaKeys> = version === undefined || version === carried.version ? {} : { version };
  if (chosen === undefined) return { file, held, changes };
  if (chosen.name !== heldName) Object.assign(changes, { archiveFilename: chosen.name });
  if (chosen.source !== undefined) {
    const fromSource = await sourceChanges(carried, chosen.source, context);
    if ('unwritable' in fromSource) return fromSource;
    Object.assign(changes, fromSource);
  } else if (chosen.name !== heldName) {
    Object.assign(changes, {
      ...(carried.nexusId === undefined ? {} : { nexusId: undefined }),
      ...((carried.installedFiles ?? []).length === 0 ? {} : { installedFiles: undefined }),
    });
  }
  return { file, held, changes };
}

export function mo2Installation(
  context: Mo2Context, { downloadedFileHash }: Pick<HashIndex, 'downloadedFileHash'>, { modMeta }: Pick<ReadingSource, 'modMeta'>,
): Pick<InstanceAdapter, 'installationFiles' | 'downloadedFile' | 'modMetadata' | 'unwritableMetadata' | 'writeModMetadata' | 'managerFilesInModFolder'> {
  return {
    modMetadata: (mod) => readOrReason(async () => {
      const meta = await modMeta(mod);
      const { archiveFilename } = meta;
      const { source } = await nexusSourceOf(meta, context);
      return { version: meta.version, installationFiles: archiveFilename === undefined ? [] : [{ name: basename(archiveFilename), source }] };
    }),

    unwritableMetadata: async (mod, metadata) => {
      const plan = await planMetadata(context, mod, metadata);
      return 'unwritable' in plan ? plan.unwritable : undefined;
    },

    writeModMetadata: (mod, metadata) => withLock(context.instanceRoot, async () => {
      const plan = await planMetadata(context, mod, metadata);
      if ('unwritable' in plan) throw new Error(plan.unwritable);
      if (Reflect.ownKeys(plan.changes).length === 0) return;
      await ensureDir(dirname(plan.file));
      await write(plan.file, changeOwnedKeysInText(plan.held, plan.changes));
    }),

    async installationFiles(mod) {
      const meta = await modMeta(mod);
      const { archiveFilename } = meta;
      if (archiveFilename === undefined) return { kind: 'read', answer: [] };
      const refused = (why: string): FileRead<readonly InstallationFile[]> =>
        ({ kind: 'unreadable', reason: `Modbench cannot tell what ${archiveFilename} installs: ${why}` });
      const located = await readOrReason(() => reinstallPath(context, archiveFilename));
      if (located.kind === 'unreadable') return refused(located.reason);
      const path = located.answer;
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: [{ path, ...(await nexusSourceOf(meta, context)), ...hashed.answer }] } : refused(hashed.reason);
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

    managerFilesInModFolder: [MOD_META_FILE_NAME],
  };
}
