import { refuse } from '../ports/refuse';
import { goneFromDisk, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';

export type InstalledMarkResult =
  | { applied: true }
  | { applied: false; refusal: string };

export async function markDownloadInstalled(adapter: InstanceAdapter, name: string): Promise<InstalledMarkResult> {
  try {
    const marked = await adapter.markDownloadedFile(name, 'Installed');
    return marked.gone ? { applied: false, refusal: goneFromDisk(name) } : { applied: true };
  } catch (err) {
    return refuse(err);
  }
}
