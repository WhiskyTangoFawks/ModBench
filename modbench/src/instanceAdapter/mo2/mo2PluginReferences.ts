// Where MO2's files name a plugin: every profile's plugin order, and LOOT's sorting rule files.

import { stripBom } from '../../loadOrderFileCodec/lineScan';
import { pluginNamesIn } from '../../loadOrderFileCodec/pluginsText';
import { errorMessage } from '../../ports/errorMessage';
import { ruleFilePluginNames } from '../../sortingRules/lootMetadata';
import { placeIn, sameName, samePath, type PlaceInFile, type PluginName, type SymbolOwner, type SymbolReading } from '../../symbolNames/symbolNames';
import { get, readOrAbsent } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import type { Mo2Context } from './mo2Context';
import { everyPluginOrderFile, sortingRuleFilePaths } from './layout';

interface PlacedName {
  readonly place: PlaceInFile;
  readonly names: PluginName;
}

type NamesIn = (file: string, text: string) => PlacedName[] | { readonly refused: string };

const orderFileNames: NamesIn = (file, text) => pluginNamesIn(text).map(({ name, line, start, end }) =>
  ({ place: { file, start: { line, character: start }, end: { line, character: end } }, names: { name } }));

const ruleFileNames: NamesIn = (file, text) => {
  const read = stripBom(text);
  const names = ruleFilePluginNames(read);
  return 'refused' in names ? names : names.map(({ name, start, end }) => ({ place: placeIn(file, read, start, end), names: { name } }));
};

async function namesIn(file: string, namesOf: NamesIn, plugin: string): Promise<SymbolReading> {
  try {
    const text = await readOrAbsent(() => get(file), undefined);
    const names = text === undefined ? [] : namesOf(file, text);
    if ('refused' in names) return { references: [], leftOut: [`${file}: ${names.refused}`] };
    return { references: names.filter(({ names: { name } }) => sameName(name, plugin)), leftOut: [] };
  } catch (err) {
    return { references: [], leftOut: [`${file}: ${errorMessage(err)}`] };
  }
}

const isBefore = (a: { line: number; character: number }, b: { line: number; character: number }): boolean =>
  a.line < b.line || (a.line === b.line && a.character <= b.character);

export function mo2PluginReferences({ instanceRoot }: Mo2Context, plan: SymbolOwner['plan']): Pick<InstanceAdapter, 'pluginReferences'> {
  const namingFiles = async (): Promise<(readonly [string, NamesIn])[]> => [
    ...(await everyPluginOrderFile(instanceRoot)).map((file) => [file, orderFileNames] as const),
    ...Object.values(sortingRuleFilePaths(instanceRoot)).map((file) => [file, ruleFileNames] as const),
  ];
  return {
    pluginReferences: {
      plan,
      async read({ name }) {
        const read = await Promise.all((await namingFiles()).map(([file, namesOf]) => namesIn(file, namesOf, name)));
        return { references: read.flatMap(({ references }) => references), leftOut: read.flatMap(({ leftOut }) => leftOut) };
      },
      async nameAt(file, text, offset) {
        const namesOf = (await namingFiles()).find(([named]) => samePath(named, file))?.[1];
        const names = namesOf?.(file, text) ?? [];
        if ('refused' in names) return undefined;
        const { start: at } = placeIn(file, stripBom(text), offset, offset);
        return names.find(({ place }) => isBefore(place.start, at) && isBefore(at, place.end))?.names;
      },
    },
  };
}
