import { refuse } from '../coreLib/refuse';
import { goneFromDisk } from '../coreLib/commandRefusals';
import { selectionOutcomeOf, type CommandResult, type SelectionResult } from '../coreLib/commandResult';
import type { DownloadedFileQuery, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { NOT_LOGGED_IN, type Nexus } from '../nexus/nexus';

type NexusAsked = Pick<Nexus, 'fileByMd5' | 'fileByName' | 'loggedIn'>;

// MO2 asks by MD5 first, and by the mod's page and file list when the MD5 settles nothing.
async function foundOnNexus(nexus: NexusAsked, { games, md5, modID, fileID }: DownloadedFileQuery, fileName: string): ReturnType<Nexus['fileByMd5']> {
  const byMd5 = await nexus.fileByMd5({ games, md5, fileName });
  const [game] = games;
  if (byMd5.found || modID === undefined || game === undefined) return byMd5;
  const byName = await nexus.fileByName({ game, modID, fileID, fileName });
  return byName.found ? byName : { found: false, reason: `${byMd5.reason} By its mod ID ${modID}: ${byName.reason}` };
}

/** A file looked up: `notice` is what MO2 says when it wrote the file's metadata although a request for more failed. */
export interface QueriedFile {
  name: string;
  notice?: string;
}

async function queryFile(adapter: InstanceAdapter, nexus: NexusAsked, name: string): Promise<CommandResult<{ notice?: string }>> {
  try {
    const queried = await adapter.downloadedFileQuery(name);
    if (queried.kind === 'unreadable') return { applied: false, refusal: queried.reason };
    if (queried.answer === undefined) return { applied: false, refusal: goneFromDisk(name) };
    const found = await foundOnNexus(nexus, queried.answer, name);
    if (!found.found) return { applied: false, refusal: found.reason };
    const written = await adapter.writeNexusFileInfo(name, found.info);
    if (written.gone) return { applied: false, refusal: goneFromDisk(name) };
    return found.notice === undefined ? { applied: true } : { applied: true, notice: found.notice };
  } catch (err) {
    return refuse(err);
  }
}

/** `modbench.downloadedFile.queryInfo` over the downloaded files: each lands on its own (commands.md, A selection is one gesture). */
export const queryInfoOver = (adapter: InstanceAdapter, nexus: NexusAsked) =>
  async (names: readonly string[]): Promise<SelectionResult<QueriedFile>> => {
    if (!(await nexus.loggedIn())) return { applied: false, refusal: NOT_LOGGED_IN };
    const toItem = (name: string, landed?: { notice?: string }): QueriedFile => (landed?.notice === undefined ? { name } : { name, notice: landed.notice });
    return { applied: true, outcome: await selectionOutcomeOf(names, (name) => queryFile(adapter, nexus, name), toItem) };
  };

export type QueryInfo = ReturnType<typeof queryInfoOver>;
