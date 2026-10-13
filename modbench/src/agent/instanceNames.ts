import { z } from 'zod';
import type { InstanceValue } from '../instanceLoader/instance';
import { downloadsNamed, filesNamed, type FileName } from './names';

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
  of: (value: InstanceValue, { downloads = [], files = [] }: { downloads?: string[]; files?: FileName[] }) => ({
    downloads: downloadsNamed(value.downloads, downloads),
    files: filesNamed(value, files),
  }),
};
