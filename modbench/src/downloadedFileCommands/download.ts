import { refuse } from '../coreLib/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { ListedFile, Nexus } from '../nexus/nexus';

type Asking = Pick<InstanceAdapter, 'nexusFileAt' | 'nexusGames' | 'putDownloadedFile'>;

interface NexusMod {
  readonly game: string;
  readonly modID: string;
  readonly fileID?: string;
}

const NUMBER = /^\d+$/;

async function modOf(adapter: Asking, text: string): Promise<CommandResult<{ mod: NexusMod }>> {
  if (NUMBER.test(text)) {
    const [game] = await adapter.nexusGames();
    return game === undefined ? { applied: false, refusal: 'Nexus has no game for the instance.' } : { applied: true, mod: { game, modID: text } };
  }
  const page = adapter.nexusFileAt(text);
  if (page === undefined) return { applied: false, refusal: `'${text}' is neither a Nexus mod ID nor the address of a mod's page on Nexus.` };
  return { applied: true, mod: { game: page.game, modID: page.modId, ...(page.fileId === undefined ? {} : { fileID: page.fileId }) } };
}

const fileListing = (files: readonly ListedFile[]): string =>
  files.map(({ fileID, name, version, category }) => `file ${fileID}, ${name}, ${version}, ${category}`).join('; ');

async function filesOf(adapter: Asking, nexus: Pick<Nexus, 'filesOf'>, mod: string): Promise<CommandResult<{ files: readonly ListedFile[]; named?: string }>> {
  try {
    const resolved = await modOf(adapter, mod);
    if (!resolved.applied) return resolved;
    if (resolved.mod.fileID !== undefined) return { applied: true, files: [], named: resolved.mod.fileID };
    const listed = await nexus.filesOf(resolved.mod);
    return listed.found ? { applied: true, files: listed.files } : { applied: false, refusal: listed.reason };
  } catch (err) {
    return refuse(err);
  }
}

async function download(
  adapter: Asking, nexus: Pick<Nexus, 'download' | 'filesOf'>, { mod, file }: { mod: string; file?: string },
): Promise<CommandResult<{ name: string }>> {
  try {
    if (file !== undefined && !NUMBER.test(file)) return { applied: false, refusal: `'${file}' is not a Nexus file ID.` };
    const resolved = await modOf(adapter, mod);
    if (!resolved.applied) return resolved;
    const fileID = file ?? resolved.mod.fileID;
    if (fileID === undefined) {
      const listed = await nexus.filesOf(resolved.mod);
      return { applied: false, refusal: listed.found ? `Name the file to download. The files of mod ${resolved.mod.modID}: ${fileListing(listed.files)}.` : listed.reason };
    }
    const fetched = await nexus.download({ game: resolved.mod.game, modID: resolved.mod.modID, fileID });
    if (!fetched.found) return { applied: false, refusal: fetched.reason };
    try {
      await adapter.putDownloadedFile(fetched.fileName, fetched.bytes, { info: fetched.info });
    } finally {
      await fetched.bytes.cancel().catch(() => undefined);
    }
    return { applied: true, name: fetched.fileName };
  } catch (err) {
    return refuse(err);
  }
}

/** `modbench.downloadedFile.download`: a Nexus file, or the one a page address names, put in the downloads under the name Nexus gives it. `filesOf` is what a pick of the mod's files lists. */
export const downloadOver = (adapter: Asking, nexus: Pick<Nexus, 'download' | 'filesOf'>) => ({
  filesOf: (mod: string) => filesOf(adapter, nexus, mod),
  download: (wanted: { mod: string; file?: string }) => download(adapter, nexus, wanted),
});

export type Download = ReturnType<typeof downloadOver>;
