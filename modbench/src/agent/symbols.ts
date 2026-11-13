import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import { Refusal } from '../drivingLib/refusal';
import type { SymbolIndex, SymbolName } from '../sourceLanguage/symbolIndex';
import { formKeysNamed } from './recordNames';
import { fitting } from './tooLarge';

const SYMBOL = {
  kind: z.enum(['plugin', 'record', 'mod', 'separator', 'downloadedFile', 'profile', 'script', 'file']),
  name: z.string(),
  origin: z.string().optional(),
};

type NamedSymbol = z.output<z.ZodObject<typeof SYMBOL>>;

async function symbolNamed(mEdit: Pick<MEditClient, 'resolveNames'>, { kind, name, origin }: NamedSymbol): Promise<SymbolName> {
  if (origin !== undefined && kind !== 'plugin') throw new Refusal(`origin names the mod that holds a plugin, and a ${kind} has none.`);
  switch (kind) {
    case 'plugin': return { kind, name, origin };
    case 'record': return { kind, formKey: (await formKeysNamed(mEdit, [name]))[0] ?? '' };
    case 'file': return { kind, path: name };
    case 'mod': case 'separator': case 'downloadedFile': case 'profile': case 'script': return { kind, name };
  }
}

type SymbolReads = { mEdit: Pick<MEditClient, 'resolveNames'>; symbols: SymbolIndex };

export const FIND_DEFINITION = {
  name: 'find_definition',
  input: SYMBOL,
  of: async ({ mEdit, symbols }: SymbolReads, args: NamedSymbol) => {
    const definition = await symbols.definitionOf(await symbolNamed(mEdit, args));
    if ('refused' in definition) throw new Refusal(definition.refused);
    return definition;
  },
};

export const LIST_REFERENCES = {
  name: 'list_references',
  input: SYMBOL,
  of: async ({ mEdit, symbols }: SymbolReads, args: NamedSymbol) => {
    const symbol = await symbolNamed(mEdit, args);
    const found = await symbols.referencesTo(symbol);
    if ('refused' in found) throw new Refusal(found.refused);
    return fitting(found, ({ references }) => ({
      references: references.length,
      ...symbol.kind === 'record' && { narrow: `select_rows reads the rows of the form_references view whose target_form_key is ${symbol.formKey}, which hold every plugin the record index holds, active or not, where this list holds the active and the compiled plugins. Its WHERE narrows them further.` },
    }));
  },
};
