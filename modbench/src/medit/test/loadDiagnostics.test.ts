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
import type { PluginDiagnosisReport } from '../ApiClient';

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

describe('publishLoadDiagnoses (#570)', () => {
  it('targets the plugin binary itself (pre-Track) and carries the refusal wording verbatim', () => {
    const collection = fakeCollection();

    publishLoadDiagnoses(collection as never, '/instance', [
      report('TrueStorms.esp', 'TS Mod', 'REGN … — fixed-size-subrecord-short, repairable (lossless): …'),
    ]);

    const [path, list] = [...collection.sets][0];
    expect(path).toBe('/instance/mods/TS Mod/TrueStorms.esp');
    expect(list[0].message).toBe('REGN … — fixed-size-subrecord-short, repairable (lossless): …');
    expect(list[0].severity).toBe(1); // Warning — a Malformed plugin still loads and plays
  });

  it('replaces the previous scan wholesale — one scan answers for the whole load order', () => {
    const collection = fakeCollection();
    publishLoadDiagnoses(collection as never, '/i', [report('A.esp', 'M', 'old')]);

    publishLoadDiagnoses(collection as never, '/i', [report('B.esp', 'M', 'new')]);

    expect(collection.cleared).toBe(2);
    expect([...collection.sets.keys()]).toEqual(['/i/mods/M/B.esp']);
  });

  it('groups several diagnoses on one plugin under one file entry', () => {
    const collection = fakeCollection();

    publishLoadDiagnoses(collection as never, '/i', [
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'),
    ]);

    expect([...collection.sets.values()][0].map((d) => d.message)).toEqual(['first', 'second']);
  });
});

describe('groupDiagnosesByPlugin (#570)', () => {
  it('keys texts by plugin filename for the tree decoration hand-off', () => {
    const grouped = groupDiagnosesByPlugin([
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'), report('B.esp', 'N', 'third'),
    ]);

    expect(grouped.get('A.esp')).toEqual(['first', 'second']);
    expect(grouped.get('B.esp')).toEqual(['third']);
  });
});
