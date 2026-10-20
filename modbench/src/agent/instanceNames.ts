import { z } from 'zod';
import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import { downloadedFilesNamed, filesNamed, type FileName } from './names';

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
  description: 'What each name means in the instance: a downloaded file by its file name, and a file in a mod by its path in the mod, '
    + 'answered in the mod\'s own casing. The mod is named as list_file_conflicts names it. A name that means nothing or more than one thing is refused, listing each match.',
  input: {
    downloads: z.array(z.string()).optional(),
    files: z.array(z.object({
      mod: z.object({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() }),
      path: z.string(),
    })).optional(),
  },
  of: (value: InstanceValue, { downloads = [], files = [] }: { downloads?: string[]; files?: FileName[] }) => {
    const refusals: string[] = [];
    const named = { downloads: refusing(refusals, [], () => downloadedFilesNamed(value.downloadedFiles, downloads)), files: refusing(refusals, [], () => filesNamed(value, files)) };
    if (refusals.length > 0) throw new Refusal(refusals.join(' '));
    return named;
  },
};
