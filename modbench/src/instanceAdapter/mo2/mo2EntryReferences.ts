// Where MO2's files name a mod or a separator: every profile's mod list, and the instance repository's ignore list and
// submodules file.

import { stripBom } from '../../loadOrderFileCodec/lineScan';
import { errorMessage } from '../../ports/errorMessage';
import { heldTextAt, offsetOf, sameName, samePath, type EntryNames, type EntrySymbol, type HeldTexts, type PlaceInFile } from '../../symbolNames/symbolNames';
import { get, readOrAbsent } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import { entryNamesIn, type EntryInText } from './codecs/modlistText';
import { everyModlistFile, ignoreListFile, ignoreListNames, modlistFile, submoduleNames, submodulesFile } from './layout';
import type { Mo2Context } from './mo2Context';
import type { ReadingSource } from '../instanceReading';

type NamesIn = (text: string) => EntryInText[];

const placeOf = (file: string, { line, start, end }: EntryInText): PlaceInFile =>
  ({ file, start: { line, character: start }, end: { line, character: end } });

const isEntry = (found: EntryInText, { kind, name }: EntrySymbol): boolean => found.entry.kind === kind && sameName(found.entry.name, name);

const withoutBom = (namesIn: NamesIn): NamesIn => (text) => namesIn(stripBom(text));

export function mo2EntryReferences({ instanceRoot }: Mo2Context, source: Pick<ReadingSource, 'settings'>): Pick<InstanceAdapter, 'entryReferences'> {
  const modlistNames = withoutBom(entryNamesIn);
  const namingFiles = async (): Promise<(readonly [string, NamesIn])[]> => [
    ...(await everyModlistFile(instanceRoot)).map((file) => [file, modlistNames] as const),
    [ignoreListFile(instanceRoot), withoutBom(ignoreListNames)],
    [submodulesFile(instanceRoot), withoutBom(submoduleNames)],
  ];
  const entryReferences: EntryNames = {
    async listed(held) {
      const file = modlistFile(instanceRoot, (await source.settings()).profile);
      const text = heldTextAt(held, file) ?? await readOrAbsent(() => get(file), undefined);
      return text === undefined ? [] : modlistNames(text).map((found) => ({ entry: found.entry, place: placeOf(file, found) }));
    },
    async read(entry, held: HeldTexts) {
      const read = await Promise.all((await namingFiles()).map(async ([file, namesIn]) => {
        try {
          const text = heldTextAt(held, file) ?? await readOrAbsent(() => get(file), undefined);
          const named = text === undefined ? [] : namesIn(text).filter((found) => isEntry(found, entry));
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
      const spans = namesIn(text).map(({ entry, line, start, end }) =>
        ({ entry, start: offsetOf(text, { line, character: start }), end: offsetOf(text, { line, character: end }) }));
      return spans.find((span) => span.start <= offset && offset <= span.end);
    },
  };
  return { entryReferences };
}
