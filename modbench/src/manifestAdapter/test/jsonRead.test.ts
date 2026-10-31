import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PATH } from '../jsonRead';

it('reads a path in the folder by the pattern the manifest schema states', () => {
  const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../spec/formats/manifest-1.schema.json'), 'utf8')) as { $defs: { path: { pattern: string } } };

  expect(PATH.source).toBe(new RegExp(schema.$defs.path.pattern).source);
});
