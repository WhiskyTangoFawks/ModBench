import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isPathInTheFolder, objectOf, textOf } from '../jsonRead';

const SCHEMA = 'manifest schema';

const schemaPath = (): RegExp => {
  const schema = objectOf(SCHEMA, JSON.parse(readFileSync(resolve(__dirname, '../../../../spec/formats/manifest-1.schema.json'), 'utf8')), 'its root');
  return new RegExp(textOf(SCHEMA, objectOf(SCHEMA, objectOf(SCHEMA, schema.$defs, '$defs').path, 'path').pattern, 'pattern'));
};

const PRINTABLE = Array.from({ length: 95 }, (_, at) => String.fromCharCode(32 + at));
const PATH_CHARACTERS = ['a', '.', '/', '\\', ':'];
const upTo = (length: number): string[] =>
  length === 0 ? [''] : [...upTo(length - 1), ...upTo(length - 1).filter((path) => path.length === length - 1).flatMap((path) => PATH_CHARACTERS.map((next) => path + next))];

it('reads a path in the folder by the pattern the manifest schema states', () => {
  const pattern = schemaPath();
  const probes = [...PRINTABLE.flatMap((character) => [character, `a${character}b`]), ...upTo(4)];

  expect(probes.filter((path) => isPathInTheFolder(path) !== pattern.test(path))).toEqual([]);
});
