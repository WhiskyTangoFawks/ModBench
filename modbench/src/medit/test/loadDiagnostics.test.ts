import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Diagnostic: class {
    constructor(public range: unknown, public message: string, public severity: number) {}
  },
  Range: class {
    constructor(public a: number, public b: number, public c: number, public d: number) {}
  },
  DiagnosticSeverity: { Warning: 1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { publishLoadDiagnoses, groupDiagnosesByPlugin } from '../loadDiagnostics';
import type { OriginFolder } from '../../modmanager/loadOrderSnapshot';
import type { PluginDiagnosisReport } from '../client';

const report = (plugin: string, origin: string, text: string): PluginDiagnosisReport => ({
  plugin, origin, anchor: null, defectClass: 'fixed-size-subrecord-short', tail: null, message: 'm', text,
});

function fakeCollection() {
  const sets = new Map<string, { message: string; severity: number }[]>();
  return {
    sets,
    cleared: 0,
    clear() { this.cleared++; sets.clear(); },
    set(uri: { fsPath: string }, list: { message: string; severity: number }[]) { sets.set(uri.fsPath, list); },
  };
}

// Stands in for the Instance value's own answer: the folder each origin's copies sit in.
const originFolderFrom = (folders: Record<string, string>): OriginFolder => (origin) => folders[origin];

describe('publishLoadDiagnoses', () => {
  it('targets the plugin binary itself (pre-Track) and carries the refusal wording verbatim', () => {
    const collection = fakeCollection();

    publishLoadDiagnoses(collection as never, originFolderFrom({ 'TS Mod': '/instance/mods/TS Mod' }), [
      report('TrueStorms.esp', 'TS Mod', 'REGN … — fixed-size-subrecord-short, repairable (lossless): …'),
    ]);

    const [path, list] = [...collection.sets][0]!;
    expect(path).toBe('/instance/mods/TS Mod/TrueStorms.esp');
    expect(list[0]!.message).toBe('REGN … — fixed-size-subrecord-short, repairable (lossless): …');
    expect(list[0]!.severity).toBe(1); // Warning — a Malformed plugin still loads and plays
  });

  // Rival: `mods/<origin>`, which put an overwrite copy's Problems entry on a path that
  // does not exist.
  it('targets the overwrite folder for an overwrite-origin copy', () => {
    const collection = fakeCollection();

    publishLoadDiagnoses(collection as never, originFolderFrom({ overwrite: '/instance/overwrite' }), [
      report('Stray.esp', 'overwrite', 'bad'),
    ]);

    expect([...collection.sets.keys()]).toEqual(['/instance/overwrite/Stray.esp']);
  });

  it('publishes nothing for an origin the value has no folder for', () => {
    const collection = fakeCollection();

    publishLoadDiagnoses(collection as never, originFolderFrom({}), [report('Ghost.esp', 'Gone', 'bad')]);

    expect([...collection.sets.keys()]).toEqual([]);
    expect(collection.cleared).toBe(1);
  });

  it('replaces the previous scan wholesale — one scan answers for the whole load order', () => {
    const collection = fakeCollection();
    const originFolder = originFolderFrom({ M: '/i/mods/M' });
    publishLoadDiagnoses(collection as never, originFolder, [report('A.esp', 'M', 'old')]);

    publishLoadDiagnoses(collection as never, originFolder, [report('B.esp', 'M', 'new')]);

    expect(collection.cleared).toBe(2);
    expect([...collection.sets.keys()]).toEqual(['/i/mods/M/B.esp']);
  });

  it('groups several diagnoses on one plugin under one file entry', () => {
    const collection = fakeCollection();

    publishLoadDiagnoses(collection as never, originFolderFrom({ M: '/i/mods/M' }), [
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'),
    ]);

    expect([...collection.sets.values()][0]!.map((d) => d.message)).toEqual(['first', 'second']);
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
