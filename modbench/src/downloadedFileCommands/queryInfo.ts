import { refuse } from '../coreLib/refuse';
import { goneFromDisk } from '../coreLib/commandRefusals';
import { selectionOutcomeOf, type CommandResult, type SelectionResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { NOT_LOGGED_IN, type Nexus } from '../nexus/nexus';

type NexusAsked = Pick<Nexus, 'fileByMd5' | 'loggedIn'>;

async function queryFile(adapter: InstanceAdapter, nexus: NexusAsked, name: string): Promise<CommandResult<{ wrote: boolean }>> {
  try {
    const hashed = await adapter.downloadedFileMd5(name);
    if (hashed.kind === 'unreadable') return { applied: false, refusal: hashed.reason };
    if (hashed.answer === undefined) return { applied: false, refusal: goneFromDisk(name) };
    const found = await nexus.fileByMd5({ ...hashed.answer, fileName: name });
    if (!found.found) return { applied: false, refusal: found.reason };
    const written = await adapter.writeNexusFileInfo(name, found.info);
    return written.gone ? { applied: false, refusal: goneFromDisk(name) } : { applied: true, wrote: written.wrote };
  } catch (err) {
    return refuse(err);
  }
}

/** `modbench.downloadedFile.queryInfo` over the downloaded files: each lands on its own (commands.md, A selection is one gesture). */
export const queryInfoOver = (adapter: InstanceAdapter, nexus: NexusAsked) =>
  async (names: readonly string[]): Promise<SelectionResult<string>> => {
    if (!(await nexus.loggedIn())) return { applied: false, refusal: NOT_LOGGED_IN };
    return { applied: true, outcome: await selectionOutcomeOf(names, (name) => queryFile(adapter, nexus, name), (name) => name) };
  };

export type QueryInfo = ReturnType<typeof queryInfoOver>;
