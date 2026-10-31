import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { MANIFEST_SUFFIX } from '../repositoriesLib/manifestPath';
import { BUILD_FILE } from '../wire/sourceMod';
import { isRecord } from './manifest';

interface Validation { fileMatch: string[]; url: string }

const FORMATS = path.resolve(__dirname, '../../../spec/formats');
const isValidation = (value: unknown): value is Validation =>
  isRecord(value) && Array.isArray(value.fileMatch) && typeof value.url === 'string';

const raw: unknown = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const declared = isRecord(raw) && isRecord(raw.contributes) ? raw.contributes.jsonValidation : undefined;
const validations: Validation[] = Array.isArray(declared) ? declared.filter(isValidation) : [];

const schemasOf = (fileName: string): string[] =>
  validations
    .filter((entry) => entry.fileMatch.some((pattern) => fileName.endsWith(pattern.replace(/^\*/, ''))))
    .map((entry) => path.basename(entry.url));

describe('jsonValidation', () => {
  it.each([
    ['a manifest', `Mod${MANIFEST_SUFFIX}`, 'manifest-1.schema.json'],
    ['a build file', BUILD_FILE, 'build-file-1.schema.json'],
  ])('checks %s against its schema in the specification', (_format, fileName, schema) => {
    expect(schemasOf(fileName)).toEqual([schema]);
    expect(existsSync(path.join(FORMATS, schema))).toBe(true);
  });
});
