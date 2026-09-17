import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, fakeUri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, Range, DiagnosticSeverity, Uri: { file: fakeUri } }));

import { publishLoadDiagnoses, groupDiagnosesByPlugin } from '../loadDiagnostics';
import type { OriginFolder } from '../../instance/loadOrderSnapshot';
import type { PluginDiagnosisReport } from '../../client';
import { present } from '../../ports/present';

const report = (plugin: string, origin: string, text: string): PluginDiagnosisReport => ({
  plugin, origin, anchor: null, defectClass: 'fixed-size-subrecord-short', tail: null, message: 'm', text,
});

// [uri.fsPath, diagnostics] pairs, in insertion order — the shape every assertion below reads.
function entriesOf(collection: FakeDiagnosticCollection) {
  return [...collection].map(([uri, diagnostics]) => [uri.fsPath, diagnostics] as const);
}

// Stands in for the Instance value's own answer: the folder each origin's copies sit in.
const originFolderFrom = (folders: Record<string, string>): OriginFolder => (origin) => folders[origin];

describe('publishLoadDiagnoses', () => {
  it('targets the plugin binary itself (pre-Track) and carries the refusal wording verbatim', () => {
    const collection = new FakeDiagnosticCollection();

    publishLoadDiagnoses(collection, originFolderFrom({ 'TS Mod': '/instance/mods/TS Mod' }), [
      report('TrueStorms.esp', 'TS Mod', 'REGN … — fixed-size-subrecord-short, repairable (lossless): …'),
    ]);

    const [path, list] = present(entriesOf(collection)[0], 'the sole published diagnostic-collection entry');
    expect(path).toBe('/instance/mods/TS Mod/TrueStorms.esp');
    const [diagnostic] = list;
    if (!diagnostic) throw new Error('the sole diagnostic published for TrueStorms.esp');
    expect(diagnostic.message).toBe('REGN … — fixed-size-subrecord-short, repairable (lossless): …');
    expect(diagnostic.severity).toBe(1); // Warning — a Malformed plugin still loads and plays
  });

  // Rival: `mods/<origin>`, which put an overwrite copy's Problems entry on a path that
  // does not exist.
  it('targets the overwrite folder for an overwrite-origin copy', () => {
    const collection = new FakeDiagnosticCollection();

    publishLoadDiagnoses(collection, originFolderFrom({ overwrite: '/instance/overwrite' }), [
      report('Stray.esp', 'overwrite', 'bad'),
    ]);

    expect(entriesOf(collection).map(([path]) => path)).toEqual(['/instance/overwrite/Stray.esp']);
  });

  it('publishes nothing for an origin the value has no folder for', () => {
    const collection = new FakeDiagnosticCollection();
    const clear = vi.spyOn(collection, 'clear');

    publishLoadDiagnoses(collection, originFolderFrom({}), [report('Ghost.esp', 'Gone', 'bad')]);

    expect(entriesOf(collection)).toEqual([]);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('replaces the previous scan wholesale — one scan answers for the whole load order', () => {
    const collection = new FakeDiagnosticCollection();
    const clear = vi.spyOn(collection, 'clear');
    const originFolder = originFolderFrom({ M: '/i/mods/M' });
    publishLoadDiagnoses(collection, originFolder, [report('A.esp', 'M', 'old')]);

    publishLoadDiagnoses(collection, originFolder, [report('B.esp', 'M', 'new')]);

    expect(clear).toHaveBeenCalledTimes(2);
    expect(entriesOf(collection).map(([path]) => path)).toEqual(['/i/mods/M/B.esp']);
  });

  it('groups several diagnoses on one plugin under one file entry', () => {
    const collection = new FakeDiagnosticCollection();

    publishLoadDiagnoses(collection, originFolderFrom({ M: '/i/mods/M' }), [
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'),
    ]);

    const [, groupedDiagnostics] = present(entriesOf(collection)[0], 'the sole grouped diagnostic-collection entry');
    expect(groupedDiagnostics.map((d) => d.message)).toEqual(['first', 'second']);
  });
});

describe('groupDiagnosesByPlugin', () => {
  it('keys texts by plugin filename for the tree decoration hand-off', () => {
    const grouped = groupDiagnosesByPlugin([
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'), report('B.esp', 'N', 'third'),
    ]);

    expect(grouped.get('A.esp')).toEqual(['first', 'second']);
    expect(grouped.get('B.esp')).toEqual(['third']);
  });
});
