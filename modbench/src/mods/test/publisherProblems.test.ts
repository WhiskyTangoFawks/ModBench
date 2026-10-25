import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import type { PublisherConfiguration, PublisherTag } from '../../instanceAdapter/instanceAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { PublisherProblems } from '../publisherProblems';

const IGNORE: PublisherTag = { name: 'Ignore', badge: 'IG', marksPaths: true };
const FILE = '/instance/compiler_settings.json';

const naming = (...lines: number[]): PublisherConfiguration => ({
  kind: 'read', covering: () => [], listed: () => [],
  pathProblems: lines.map((line) => ({ kind: 'namesNoPath', file: FILE, line, tag: IGNORE, entry: `gone${line}` })),
});

const instanceHolding = (publisherConfiguration: PublisherConfiguration) =>
  new FakeInstance(instanceValueFixture({ publisherConfiguration }));

const lineRange = (line: number) => new Range(line, 0, line, Number.MAX_SAFE_INTEGER);

const problemsOf = (collection: FakeDiagnosticCollection) =>
  (collection.get(Uri.file(FILE)) ?? []).map(({ range, message, severity }) => [range, message, severity]);

describe('a publisher tag that names no path (publishing.md, Publisher tags, story 4)', () => {
  it('shows a warning on its line in the publisher\'s configuration, zero-based for the panel', () => {
    const collection = new FakeDiagnosticCollection();

    new PublisherProblems(collection, instanceHolding(naming(3, 7)));

    expect(problemsOf(collection)).toEqual([
      [lineRange(2), 'Ignore: "gone3" names no path in the instance.', DiagnosticSeverity.Warning],
      [lineRange(6), 'Ignore: "gone7" names no path in the instance.', DiagnosticSeverity.Warning],
    ]);
  });

  it('says an entry it could not check, and why', () => {
    const collection = new FakeDiagnosticCollection();
    const unchecked: PublisherConfiguration = {
      kind: 'read', covering: () => [], listed: () => [],
      pathProblems: [{ kind: 'notChecked', file: FILE, line: 1, tag: IGNORE, entry: 'mods\\loop', reason: 'ELOOP' }],
    };

    new PublisherProblems(collection, instanceHolding(unchecked));

    expect(problemsOf(collection).map(([, message]) => message)).toEqual(['Ignore: "mods\\loop" could not be checked: ELOOP']);
  });

  it('follows each read of the instance, and clears when none is left', () => {
    const collection = new FakeDiagnosticCollection();
    const instance = instanceHolding(naming(3));
    new PublisherProblems(collection, instance);

    instance.publish({ ...instance.value, publisherConfiguration: naming(5) });
    const afterChange = problemsOf(collection).map(([range]) => range);
    instance.publish({ ...instance.value, publisherConfiguration: { kind: 'none' } });

    expect({ afterChange, afterNone: collection.has(Uri.file(FILE)) }).toEqual({ afterChange: [lineRange(4)], afterNone: false });
  });

  it('stops following the instance when disposed', () => {
    const collection = new FakeDiagnosticCollection();
    const instance = instanceHolding({ kind: 'none' });
    new PublisherProblems(collection, instance).dispose();

    instance.publish({ ...instance.value, publisherConfiguration: naming(1) });

    expect(collection.has(Uri.file(FILE))).toBe(false);
  });
});
