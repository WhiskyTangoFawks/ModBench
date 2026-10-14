import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import type { InstanceValue } from '../instanceLoader/instance';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';
import { pluginsNamed } from './names';
import { formKeysNamed } from './recordNames';

const RECORD = {
  name: z.string(),
  plugin: z.object({ name: z.string(), origin: z.string().optional() }).optional(),
};

export const READ_RECORD = {
  name: 'read_record',
  description: 'A record in the load order, by its EditorID or FormKey: every active plugin\'s copy and the copy that wins. '
    + 'With plugin { name, origin? } as list_plugins shows it, that plugin\'s copy alone, whether the plugin is active or not.',
  input: RECORD,
  of: async (
    mEdit: Pick<MEditClient, 'resolveNames' | 'getComparison' | 'getCopyDocument'>,
    value: InstanceValue,
    { name, plugin }: { name: string; plugin?: { name: string; origin?: string } },
  ) => {
    const [formKey = ''] = await formKeysNamed(mEdit, [name]);
    const [address] = plugin === undefined ? [] : pluginsNamed(value.plugins, [plugin]);
    const copies = address === undefined ? await mEdit.getComparison(formKey) : await mEdit.getCopyDocument(address, formKey);
    if (isReadFailed(copies)) throw new Refusal(failureReason(copies));
    if (copies === null) {
      throw new Refusal(address === undefined ? `No active plugin holds ${formKey}.` : `${address.name} in ${address.origin} holds no ${formKey}.`);
    }
    return copies;
  },
};

export const LIST_REFERENCES = {
  name: 'list_references',
  description: 'The records that reference a record, by its EditorID or FormKey.',
  input: { name: z.string() },
  of: async (mEdit: Pick<MEditClient, 'resolveNames' | 'getReferences'>, { name }: { name: string }) => {
    const [formKey = ''] = await formKeysNamed(mEdit, [name]);
    const referrers = await mEdit.getReferences(formKey);
    if (isReadFailed(referrers)) throw new Refusal(failureReason(referrers));
    return referrers;
  },
};
