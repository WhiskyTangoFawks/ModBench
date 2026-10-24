import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, uriFile, fakeUri, FakeDiagnosticCollection } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri: { file: uriFile } }));

import type { PublisherConfiguration, PublisherTag } from '../../instanceAdapter/instanceAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { valueWithSourceDirs } from './sourceDirsFixture';
import { PublisherProblems } from '../publisherProblems';

const IGNORE: PublisherTag = { name: 'Ignore', badge: 'IG', marksPaths: true };
const FILE = '/instance/compiler_settings.json';

const naming = (...lines: number[]): PublisherConfiguration => ({
  kind: 'read', covering: () => [], listed: () => [],
  namesNoPath: lines.map((line) => ({ file: FILE, line, tag: IGNORE, entry: `gone${line}` })),
});

const instanceHolding = (publisherConfiguration: PublisherConfiguration) =>
  new FakeInstance({ ...valueWithSourceDirs(new Map()), publisherConfiguration });

const lineRange = (line: number) => new Range(line, 0, line, Number.MAX_SAFE_INTEGER);

const problemsOf = (collection: FakeDiagnosticCollection) =>
  (collection.get(fakeUri(FILE)) ?? []).map(({ range, message, severity }) => [range, message, severity]);

describe('a publisher tag that names no path (publishing.md, Publisher tags, story 4)', () => {
  it('shows a warning on its line in the publisher\'s configuration, zero-based for the panel', () => {
    const collection = new FakeDiagnosticCollection();

    new PublisherProblems(collection, instanceHolding(naming(3, 7)));

    expect(problemsOf(collection)).toEqual([
      [lineRange(2), 'Ignore: "gone3" names no path in the instance.', DiagnosticSeverity.Warning],
      [lineRange(6), 'Ignore: "gone7" names no path in the instance.', DiagnosticSeverity.Warning],
    ]);
  });

  it('follows each read of the instance, and clears when none is left', () => {
    const collection = new FakeDiagnosticCollection();
    const instance = instanceHolding(naming(3));
    new PublisherProblems(collection, instance);

    instance.publish({ ...instance.value, publisherConfiguration: naming(5) });
    const afterChange = problemsOf(collection).map(([range]) => range);
    instance.publish({ ...instance.value, publisherConfiguration: { kind: 'none' } });

    expect({ afterChange, afterNone: collection.has(fakeUri(FILE)) }).toEqual({ afterChange: [lineRange(4)], afterNone: false });
  });

  it('stops following the instance when disposed', () => {
    const collection = new FakeDiagnosticCollection();
    const instance = instanceHolding({ kind: 'none' });
    new PublisherProblems(collection, instance).dispose();

    instance.publish({ ...instance.value, publisherConfiguration: naming(1) });

    expect(collection.has(fakeUri(FILE))).toBe(false);
  });
});
