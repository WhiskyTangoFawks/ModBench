import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { manifestFileFor } from '../manifestAdapter';
import { isRecord } from '../../test/manifest';
import { modFolderHolding } from './modFolderHolding';

const schemaPath = (): RegExp => {
  const schema: unknown = JSON.parse(readFileSync(resolve(__dirname, '../../../../spec/formats/manifest-1.schema.json'), 'utf8'));
  const path = isRecord(schema) && isRecord(schema.$defs) && isRecord(schema.$defs.path) ? schema.$defs.path : {};
  if (typeof path.pattern !== 'string') throw new Error('the manifest schema states no path pattern');
  return new RegExp(path.pattern);
};

const PRINTABLE = Array.from({ length: 95 }, (_, at) => String.fromCharCode(32 + at));
const PATH_CHARACTERS = ['a', '.', '/', '\\', ':'];
const upTo = (length: number): string[] =>
  length === 0 ? [''] : [...upTo(length - 1), ...upTo(length - 1).filter((path) => path.length === length - 1).flatMap((path) => PATH_CHARACTERS.map((next) => path + next))];

const takes = (folder: string, path: string): Promise<boolean> =>
  manifestFileFor(folder, { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map([[path, 'AAAAAAAAAAA=']]) }).then(() => true, () => false);

it('takes a manifest naming a path in the folder by the pattern the manifest schema states, and refuses one naming any other', async () => {
  const pattern = schemaPath();
  const folder = modFolderHolding({});
  const probes = [...PRINTABLE.flatMap((character) => [character, `a${character}b`]), ...upTo(4)];

  expect(Object.fromEntries(await Promise.all(probes.map(async (path) => [path, await takes(folder, path)]))))
    .toEqual(Object.fromEntries(probes.map((path) => [path, pattern.test(path)])));
});
