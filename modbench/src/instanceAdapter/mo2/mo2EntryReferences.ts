// Where MO2's files name a mod or a separator: every profile's mod list, and the instance repository's ignore list and
// submodules file.

import { stripBom } from '../../loadOrderFileCodec/lineScan';
import { errorMessage } from '../../ports/errorMessage';
import { heldTextAt, placeIn, sameName, samePath, type EntryNames, type EntrySymbol, type HeldTexts, type PlaceInFile } from '../../symbolNames/symbolNames';
import { get, readOrAbsent } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import { entryNamesIn, type EntryInText } from './codecs/modlistText';
import { everyModlistFile, ignoreListFile, ignoreListNames, submoduleNames, submodulesFile } from './layout';
import type { Mo2Context } from './mo2Context';

type NamesIn = (text: string) => EntryInText[];

const placeOf = (file: string, { line, start, end }: EntryInText): PlaceInFile =>
  ({ file, start: { line, character: start }, end: { line, character: end } });

const isEntry = (found: EntryInText, { kind, name }: EntrySymbol): boolean => found.entry.kind === kind && sameName(found.entry.name, name);

const isBefore = (a: { line: number; character: number }, b: { line: number; character: number }): boolean =>
  a.line < b.line || (a.line === b.line && a.character <= b.character);

export function mo2EntryReferences({ instanceRoot }: Mo2Context): Pick<InstanceAdapter, 'entryReferences'> {
  const namingFiles = async (): Promise<(readonly [string, NamesIn])[]> => [
    ...(await everyModlistFile(instanceRoot)).map((file) => [file, entryNamesIn] as const),
    [ignoreListFile(instanceRoot), ignoreListNames],
    [submodulesFile(instanceRoot), submoduleNames],
  ];
  const entryReferences: EntryNames = {
    async read(entry, held: HeldTexts) {
      const read = await Promise.all((await namingFiles()).map(async ([file, namesIn]) => {
        try {
          const text = heldTextAt(held, file) ?? await readOrAbsent(() => get(file), undefined);
          const named = text === undefined ? [] : namesIn(stripBom(text)).filter((found) => isEntry(found, entry));
          return { references: named.map((found) => placeOf(file, found)), leftOut: [] };
        } catch (err) {
          return { references: [], leftOut: [`${file}: ${errorMessage(err)}`] };
        }
      }));
      return { references: read.flatMap(({ references }) => references), leftOut: read.flatMap(({ leftOut }) => leftOut) };
    },
    async nameAt(file, text, offset) {
      const namesIn = (await namingFiles()).find(([named]) => samePath(named, file))?.[1];
      if (namesIn === undefined) return undefined;
      const { start: at } = placeIn(file, stripBom(text), offset, offset);
      return namesIn(stripBom(text)).find(({ line, start, end }) => isBefore({ line, character: start }, at) && isBefore(at, { line, character: end }))?.entry;
    },
  };
  return { entryReferences };
}
