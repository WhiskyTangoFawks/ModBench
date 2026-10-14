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
    + 'With plugin { name, origin? } as list_plugins shows it, that plugin\'s copy alone, whether the plugin is active or not: '
    + '{ kind: \'OwnFile\' | \'ContainersFile\', location } the path of the source file that holds it, or { kind: \'Rendered\', text } the copy\'s text, for a plugin with no source.',
  input: RECORD,
  of: async (
    mEdit: Pick<MEditClient, 'resolveNames' | 'getComparison' | 'getCopyDocument' | 'getRenderedDocument'>,
    value: InstanceValue,
    { name, plugin }: { name: string; plugin?: { name: string; origin?: string } },
  ) => {
    const [formKey = ''] = await formKeysNamed(mEdit, [name]);
    const [address] = plugin === undefined ? [] : pluginsNamed(value.plugins, [plugin]);
    if (address === undefined) {
      const copies = await mEdit.getComparison(formKey);
      if (isReadFailed(copies)) throw new Refusal(failureReason(copies));
      if (copies === null) throw new Refusal(`No active plugin holds ${formKey}.`);
      return copies;
    }
    const holdsNone = new Refusal(`${address.name} in ${address.origin} holds no ${formKey}.`);
    const document = await mEdit.getCopyDocument(address, formKey);
    if (isReadFailed(document)) throw new Refusal(failureReason(document));
    if (document === null) throw holdsNone;
    if (document.kind !== 'Rendered') return document;
    const rendered = await mEdit.getRenderedDocument(address, formKey);
    if (isReadFailed(rendered)) throw new Refusal(failureReason(rendered));
    if (rendered === null) throw holdsNone;
    return { kind: document.kind, text: rendered.text };
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
