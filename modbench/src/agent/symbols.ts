import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import type { SymbolIndex, SymbolName } from '../symbols/symbolIndex';
import { pluginsNamed } from './names';
import { formKeysNamed } from './recordNames';
import { fitting } from './tooLarge';

const SYMBOL = {
  kind: z.enum(['plugin', 'record', 'mod', 'separator', 'downloadedFile', 'profile', 'script', 'file']),
  name: z.string(),
  origin: z.string().optional(),
};

type NamedSymbol = z.output<z.ZodObject<typeof SYMBOL>>;

type Naming = { mEdit: Pick<MEditClient, 'resolveNames'>; value: InstanceValue };

async function symbolNamed({ mEdit, value }: Naming, { kind, name, origin }: NamedSymbol): Promise<SymbolName> {
  if (origin !== undefined && kind !== 'plugin') throw new Refusal(`origin names the mod that holds a plugin, and a ${kind} has none.`);
  switch (kind) {
    case 'plugin': {
      const [plugin = { name, origin }] = pluginsNamed(value, [{ name, origin }]);
      return { kind, ...plugin };
    }
    case 'record': return { kind, formKey: (await formKeysNamed(mEdit, [name]))[0] ?? '' };
    case 'file': return { kind, path: name };
    case 'mod': case 'separator': case 'downloadedFile': case 'profile': case 'script': return { kind, name };
  }
}

type SymbolReads = Naming & { symbols: SymbolIndex };

export const FIND_DEFINITION = {
  name: 'find_definition',
  input: SYMBOL,
  of: async ({ symbols, ...naming }: SymbolReads, args: NamedSymbol) => {
    const definition = await symbols.definitionOf(await symbolNamed(naming, args));
    if ('refused' in definition) throw new Refusal(definition.refused);
    return definition;
  },
};

export const LIST_REFERENCES = {
  name: 'list_references',
  input: SYMBOL,
  of: async ({ symbols, ...naming }: SymbolReads, args: NamedSymbol) => {
    const symbol = await symbolNamed(naming, args);
    const found = await symbols.referencesTo(symbol);
    if ('refused' in found) throw new Refusal(found.refused);
    return fitting(found, ({ references }) => ({
      references: references.length,
      ...symbol.kind === 'record' && { narrow: `select_rows reads the rows of the form_references view whose target_form_key is ${symbol.formKey}, which hold every plugin the record index holds, active or not, where this list holds the active and the compiled plugins. Its WHERE narrows them further.` },
    }));
  },
};
