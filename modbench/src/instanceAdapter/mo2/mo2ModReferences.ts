// Where MO2's files name a mod: every profile's mod list.

import { errorMessage } from '../../ports/errorMessage';
import { heldTextAt, placeIn, sameName, samePath, type HeldTexts, type ModNames, type PlaceInFile } from '../../symbolNames/symbolNames';
import { get, readOrAbsent } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import { modNamesIn } from './codecs/modlistText';
import { stripBom } from '../../loadOrderFileCodec/lineScan';
import { everyModlistFile } from './layout';
import type { Mo2Context } from './mo2Context';

const placeOf = (file: string, { line, start, end }: { line: number; start: number; end: number }): PlaceInFile =>
  ({ file, start: { line, character: start }, end: { line, character: end } });

export function mo2ModReferences({ instanceRoot }: Mo2Context): Pick<InstanceAdapter, 'modReferences'> {
  const modReferences: ModNames = {
    async read(mod, held: HeldTexts) {
      const files = await everyModlistFile(instanceRoot);
      const read = await Promise.all(files.map(async (file) => {
        try {
          const text = heldTextAt(held, file) ?? await readOrAbsent(() => get(file), undefined);
          const named = text === undefined ? [] : modNamesIn(text).filter(({ name }) => sameName(name, mod));
          return { references: named.map((one) => placeOf(file, one)), leftOut: [] };
        } catch (err) {
          return { references: [], leftOut: [`${file}: ${errorMessage(err)}`] };
        }
      }));
      return { references: read.flatMap(({ references }) => references), leftOut: read.flatMap(({ leftOut }) => leftOut) };
    },
    async nameAt(file, text, offset) {
      if (!(await everyModlistFile(instanceRoot)).some((listed) => samePath(listed, file))) return undefined;
      const { start: at } = placeIn(file, stripBom(text), offset, offset);
      return modNamesIn(text).find(({ line, start, end }) => line === at.line && start <= at.character && at.character <= end)?.name;
    },
  };
  return { modReferences };
}
