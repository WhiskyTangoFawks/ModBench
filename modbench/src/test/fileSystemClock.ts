import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const modifiedNs = async (path: string): Promise<bigint> => (await stat(path, { bigint: true })).mtimeNs;

/** Resolves once a write stamps a later date modified than every write before the call. NTFS's clock moves every
 *  15.6 ms, more coarsely than a test's steps follow each other. */
export async function fileSystemClockMovedOn(): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'modbench-clock-'));
  const probe = join(folder, 'probe');
  try {
    await writeFile(probe, '');
    const before = await modifiedNs(probe);
    do await writeFile(probe, ''); while (await modifiedNs(probe) === before);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
