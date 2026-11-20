import { posix } from 'node:path';
import type { FilesSetAside, MEditClient } from '../client/MEditClient';
import { fileInFolder, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { MoveToTrash } from '../ports/trash';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

interface SetAsideDeps {
  readonly client: Pick<MEditClient, 'onFilesSetAside'>;
  readonly adapter: Pick<InstanceAdapter, 'trashFileIn'>;
  readonly trash: MoveToTrash;
  readonly reporter: Reporter;
}

// Each file is trashed where it was set aside, never as the plugin's own path, so the plugin the make wrote never moves.
async function whyNotTrashed({ adapter, trash }: SetAsideDeps, folder: string, path: string): Promise<string | undefined> {
  try {
    return await adapter.trashFileIn(folder, path, trash);
  } catch (err) {
    return errorMessage(err);
  }
}

async function trashEach(deps: SetAsideDeps, { folder, paths }: FilesSetAside): Promise<void> {
  for (const path of paths) {
    const why = await whyNotTrashed(deps, folder, path);
    if (why === undefined) continue;
    deps.reporter.report('error', `Moving ${posix.basename(path)}, which a Modbench script replaced, to the trash did not finish. It was at ${fileInFolder(folder, path)}.`, why);
  }
}

/** scripts.md, Writing, story 8: each file mEdit set aside in place of overwriting it goes to the trash. */
export function trashSetAsideOn(deps: SetAsideDeps): { dispose(): void } {
  return { dispose: deps.client.onFilesSetAside((setAside) => { void trashEach(deps, setAside); }) };
}
