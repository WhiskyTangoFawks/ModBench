import { z } from 'zod';
import type { InstanceValue } from '../instanceLoader/instance';
import { originLabel } from '../instanceLoader/fileConflictIndex';
import { Refusal } from '../drivingLib/refusal';
import { CONTAINER_NAME, downloadedFilesNamed, filesNamed, type FileName } from './names';

function refusing<T>(refusals: string[], otherwise: T, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refusals.push(error.message);
    return otherwise;
  }
}

export const RESOLVE_INSTANCE_NAMES = {
  name: 'resolve_instance_names',
  input: {
    downloads: z.array(z.string()).optional(),
    files: z.array(z.strictObject({
      mod: CONTAINER_NAME,
      path: z.string(),
    })).optional(),
  },
  of: (value: InstanceValue, { downloads = [], files = [] }: { downloads?: string[]; files?: FileName[] }) => {
    const refusals: string[] = [];
    const named = { downloads: refusing(refusals, [], () => downloadedFilesNamed(value.downloadedFiles, downloads)), files: refusing(refusals, [], () => filesNamed(value, files).map(({ origin, file }) => ({ mod: originLabel(origin), file }))) };
    if (refusals.length > 0) throw new Refusal(refusals.join(' '));
    return named;
  },
};
