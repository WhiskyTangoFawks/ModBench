// Where MO2's files name a symbol: a mod or a separator in every profile's mod list, the ignore list and the submodules
// file; a downloaded file in each mod's meta.ini; a profile in ModOrganizer.ini.

import { dirname } from 'node:path';
import { stripBom } from '../../loadOrderFileCodec/lineScan';
import { errorMessage } from '../../ports/errorMessage';
import { heldTextAt, offsetOf, sameName, samePath, type EntryNames, type EntrySymbol, type HeldTexts, type PlaceInFile } from '../../symbolNames/symbolNames';
import { get, ignoreSkippedLink, readOrAbsent } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import { installationFileAt } from './codecs/metaIni';
import { selectedProfileAt } from './codecs/modOrganizerIni';
import { entryNamesIn } from './codecs/modlistText';
import { everyModlistFile, ignoreListFile, ignoreListNames, modlistFile, modMetaFileIn, modsDir, settingsFile, submoduleNames, submodulesFile } from './layout';
import { listModFolders, type Mo2Context } from './mo2Context';
import type { ReadingSource } from '../instanceReading';

interface NamedInText {
  readonly entry: EntrySymbol;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

type NamesIn = (text: string) => readonly NamedInText[];

type Kind = EntrySymbol['kind'];

const placeOf = (file: string, { line, start, end }: NamedInText): PlaceInFile =>
  ({ file, start: { line, character: start }, end: { line, character: end } });

const isEntry = (found: NamedInText, { kind, name }: EntrySymbol): boolean => found.entry.kind === kind && sameName(found.entry.name, name);

const withoutBom = (namesIn: NamesIn): NamesIn => (text) => namesIn(stripBom(text));

const namedBy = (kind: Kind, at: (text: string) => { name: string; line: number; start: number; end: number } | undefined): NamesIn => (text) => {
  const found = at(text);
  return found === undefined ? [] : [{ entry: { kind, name: found.name }, line: found.line, start: found.start, end: found.end }];
};

const modlistNames = withoutBom(entryNamesIn);
const installationFileNames = namedBy('downloadedFile', installationFileAt);
const selectedProfileNames = namedBy('profile', selectedProfileAt);

export function mo2EntryReferences(context: Mo2Context, source: Pick<ReadingSource, 'settings'>): Pick<InstanceAdapter, 'entryReferences'> {
  const { instanceRoot } = context;
  const modMetaFiles = async (): Promise<string[]> =>
    (await listModFolders(context, ignoreSkippedLink) ?? []).flatMap(({ kind, path }) => (kind === 'mod' ? [modMetaFileIn(path)] : []));
  const isModMetaFile = (file: string): boolean => samePath(file, modMetaFileIn(dirname(file))) && samePath(dirname(dirname(file)), modsDir(instanceRoot));
  const namingFiles = async (kind: Kind): Promise<(readonly [string, NamesIn])[]> => {
    if (kind === 'downloadedFile') return (await modMetaFiles()).map((file) => [file, installationFileNames] as const);
    if (kind === 'profile') return [[settingsFile(instanceRoot), selectedProfileNames]];
    return [
      ...(await everyModlistFile(instanceRoot)).map((file) => [file, modlistNames] as const),
      [ignoreListFile(instanceRoot), withoutBom(ignoreListNames)],
      [submodulesFile(instanceRoot), withoutBom(submoduleNames)],
    ];
  };
  const namesInFile = async (file: string): Promise<NamesIn | undefined> => {
    if (isModMetaFile(file)) return installationFileNames;
    if (samePath(file, settingsFile(instanceRoot))) return selectedProfileNames;
    return (await namingFiles('mod')).find(([naming]) => samePath(naming, file))?.[1];
  };
  const textOf = async (file: string, held: HeldTexts): Promise<string | undefined> => heldTextAt(held, file) ?? await readOrAbsent(() => get(file), undefined);
  // Go to Symbol places a mod or a separator at its line in the active profile's mod list alone.
  const listingFiles = async (kind: Kind): Promise<(readonly [string, NamesIn])[]> =>
    (kind === 'mod' || kind === 'separator' ? [[modlistFile(instanceRoot, (await source.settings()).profile), modlistNames]] : await namingFiles(kind));

  const entryReferences: EntryNames = {
    async listed(kind, held) {
      const listed = await Promise.all((await listingFiles(kind)).map(async ([file, namesIn]) => {
        const text = await textOf(file, held);
        return text === undefined ? [] : namesIn(text).filter((found) => found.entry.kind === kind).map((found) => ({ entry: found.entry, place: placeOf(file, found) }));
      }));
      return listed.flat();
    },
    async read(entry, held: HeldTexts) {
      const read = await Promise.all((await namingFiles(entry.kind)).map(async ([file, namesIn]) => {
        try {
          const text = await textOf(file, held);
          const found = text === undefined ? [] : namesIn(text).filter((each) => isEntry(each, entry));
          return { references: found.map((each) => placeOf(file, each)), leftOut: [] };
        } catch (err) {
          return { references: [], leftOut: [`${file}: ${errorMessage(err)}`] };
        }
      }));
      return { references: read.flatMap(({ references }) => references), leftOut: read.flatMap(({ leftOut }) => leftOut) };
    },
    async nameAt(file, text, offset) {
      const namesIn = await namesInFile(file);
      if (namesIn === undefined) return undefined;
      const spans = namesIn(text).map(({ entry, line, start, end }) =>
        ({ entry, start: offsetOf(text, { line, character: start }), end: offsetOf(text, { line, character: end }) }));
      return spans.find((span) => span.start <= offset && offset <= span.end);
    },
  };
  return { entryReferences };
}
