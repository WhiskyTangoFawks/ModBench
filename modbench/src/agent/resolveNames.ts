import { z } from 'zod';
import type { MEditClient, NameQuery } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from './instanceReads';

export const RESOLVE_NAMES = {
  name: 'resolve_names',
  description: 'What each name means in the load order, as plugins and records: a plugin by its file name, with its origin when two plugins share the file name; '
    + 'a record by its EditorID or FormKey. A name that means more than one thing is refused, listing each match.',
  input: { names: z.array(z.object({ name: z.string(), origin: z.string().optional() })) },
  of: async (mEdit: Pick<MEditClient, 'resolveNames'>, { names }: { names: NameQuery[] }) => {
    const named = await mEdit.resolveNames(names);
    if (isReadFailed(named)) throw new Refusal(failureReason(named));
    return named;
  },
};
