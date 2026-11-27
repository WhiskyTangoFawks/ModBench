import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { DiagnosticSeverity, Range, Uri } from '../../test/vscodeMock';
import type { PublisherConfiguration, PublisherTag } from '../../instanceAdapter/instanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const IGNORE: PublisherTag = { name: 'Ignore', badge: 'IG', marksPaths: true };
const FILE = '/instance/compiler_settings.json';

const naming = (...lines: number[]): PublisherConfiguration => ({
  kind: 'read', covering: () => [], listed: () => [],
  pathProblems: lines.map((line) => ({ kind: 'namesNoPath', file: FILE, line, tag: IGNORE, entry: `gone${line}` })), unshippable: { file: '', reason: () => undefined },
});

const viewHolding = (publisherConfiguration: PublisherConfiguration) => {
  const shown = modsViewOn({ value: instanceValueFixture({ publisherConfiguration }) });
  const problems = () => (shown.diagnostics('modbench-publisher').get(Uri.file(FILE)) ?? []).map(({ range, message, severity }) => [range, message, severity]);
  return { ...shown, problems };
};

const lineRange = (line: number) => new Range(line, 0, line, Number.MAX_SAFE_INTEGER);

describe('a publisher tag that names no path (publishing.md, Publisher tags, story 4)', () => {
  it('shows a warning on its line in the publisher\'s configuration, zero-based for the panel', () => {
    const { problems } = viewHolding(naming(3, 7));

    expect(problems()).toEqual([
      [lineRange(2), 'Ignore: "gone3" names no path in the instance.', DiagnosticSeverity.Warning],
      [lineRange(6), 'Ignore: "gone7" names no path in the instance.', DiagnosticSeverity.Warning],
    ]);
  });

  it('says an entry it could not check, and why', () => {
    const { problems } = viewHolding({
      kind: 'read', covering: () => [], listed: () => [],
      pathProblems: [{ kind: 'notChecked', file: FILE, line: 1, tag: IGNORE, entry: 'mods\\loop', reason: 'ELOOP' }], unshippable: { file: '', reason: () => undefined },
    });

    expect(problems().map(([, message]) => message)).toEqual(['Ignore: "mods\\loop" could not be checked: ELOOP']);
  });

  it('follows each read of the instance, and clears when none is left', () => {
    const { instance, problems } = viewHolding(naming(3));

    instance.publish({ ...instance.value, publisherConfiguration: naming(5) });
    const afterChange = problems().map(([range]) => range);
    instance.publish({ ...instance.value, publisherConfiguration: { kind: 'none' } });

    expect({ afterChange, afterNone: problems() }).toEqual({ afterChange: [lineRange(4)], afterNone: [] });
  });

  it('stops following the instance when disposed', () => {
    const { mods, instance, problems } = viewHolding({ kind: 'none' });
    mods.dispose();

    instance.publish({ ...instance.value, publisherConfiguration: naming(1) });

    expect(problems()).toEqual([]);
  });
});
