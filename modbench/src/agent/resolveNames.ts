import { z } from 'zod';
import type { MEditClient, NameQuery } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';

export const RESOLVE_NAMES = {
  name: 'resolve_names',
  input: { names: z.array(z.strictObject({ name: z.string(), origin: z.string().optional() })) },
  of: async (mEdit: Pick<MEditClient, 'resolveNames'>, { names }: { names: NameQuery[] }) => {
    const named = await mEdit.resolveNames(names);
    if (isReadFailed(named)) throw new Refusal(failureReason(named));
    return named;
  },
};
