// Where MO2's files name a plugin: every profile's plugin order, and LOOT's sorting rule files.

import { pluginNamesIn } from '../../loadOrderFileCodec/pluginsText';
import { errorMessage } from '../../ports/errorMessage';
import { ruleFilePluginNames } from '../../sortingRules/ruleFileNames';
import { placeIn, type SymbolReading, type SymbolReference } from '../../symbolNames/symbolNames';
import { get, ignoreSkippedLink, listFolders, readOrAbsent } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import type { Mo2Context } from './mo2Context';
import { pluginOrderFiles, profilesDir, sortingRuleFilePaths } from './layout';

/** Every profile's plugin order files, by profile name. */
export async function everyPluginOrderFile(instanceRoot: string): Promise<string[]> {
  const profiles = await readOrAbsent(() => listFolders(profilesDir(instanceRoot), ignoreSkippedLink), []);
  return profiles.sort().flatMap((name) => pluginOrderFiles(instanceRoot, name));
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const stripBom = (text: string): string => text.replace(/^﻿/, '');

type NamesIn = (file: string, text: string) => SymbolReference[] | { readonly refused: string };

const orderFileNames: NamesIn = (file, text) => pluginNamesIn(text).map(({ name, line, start, end }) =>
  ({ place: { file, start: { line, character: start }, end: { line, character: end } }, names: { name } }));

const ruleFileNames: NamesIn = (file, text) => {
  const names = ruleFilePluginNames(stripBom(text));
  return 'refused' in names ? names : names.map(({ name, start, end }) => ({ place: placeIn(file, stripBom(text), start, end), names: { name } }));
};

async function namesIn(files: readonly string[], namesOf: NamesIn, plugin: string): Promise<SymbolReading> {
  const read = await Promise.all(files.map(async (file): Promise<SymbolReading> => {
    try {
      const text = await readOrAbsent(() => get(file), undefined);
      const names = text === undefined ? [] : namesOf(file, text);
      if ('refused' in names) return { references: [], leftOut: [`${file}: ${names.refused}`] };
      return { references: names.filter(({ names: { name } }) => sameName(name, plugin)), leftOut: [] };
    } catch (err) {
      return { references: [], leftOut: [`${file}: ${errorMessage(err)}`] };
    }
  }));
  return { references: read.flatMap(({ references }) => references), leftOut: read.flatMap(({ leftOut }) => leftOut) };
}

export function mo2PluginReferences({ instanceRoot }: Mo2Context): Pick<InstanceAdapter, 'pluginReferences'> {
  return {
    pluginReferences: {
      async read({ name }) {
        const [orders, rules] = await Promise.all([
          namesIn(await everyPluginOrderFile(instanceRoot), orderFileNames, name),
          namesIn(Object.values(sortingRuleFilePaths(instanceRoot)), ruleFileNames, name),
        ]);
        return { references: [...orders.references, ...rules.references], leftOut: [...orders.leftOut, ...rules.leftOut] };
      },
    },
  };
}
