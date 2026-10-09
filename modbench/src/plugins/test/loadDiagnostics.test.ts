import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, fakeUri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, Range, DiagnosticSeverity, Uri: { file: fakeUri } }));

import { publishPluginWarnings } from '../loadDiagnostics';
import type { PluginAddress, PluginDiagnosisReport } from '../../client';
import { present } from '../../ports/present';

const report = (plugin: string, origin: string, text: string): PluginDiagnosisReport => ({
  plugin, origin, anchor: null, defectClass: 'fixed-size-subrecord-short', tail: null, message: 'm', text,
});

function entriesAsFsPathAndDiagnosticsInInsertionOrder(collection: FakeDiagnosticCollection) {
  return [...collection].map(([uri, diagnostics]) => [uri.fsPath, diagnostics] as const);
}

const pluginFilesFrom = (files: Record<string, string>) => ({ name, origin }: PluginAddress): string | undefined =>
  files[`${origin}/${name}`];

describe('publishPluginWarnings', () => {
  it('targets the plugin binary itself (pre-Track), carries the refusal wording verbatim, and warns rather than errors since a Malformed plugin still loads and plays', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginWarnings(collection, pluginFilesFrom({ 'TS Mod/InventedWeather.esp': '/instance/mods/TS Mod/InventedWeather.esp' }), [
      report('InventedWeather.esp', 'TS Mod', 'REGN … — fixed-size-subrecord-short, repairable (lossless): …'),
    ]);

    const [path, list] = present(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)[0], 'the sole published diagnostic-collection entry');
    expect(path).toBe('/instance/mods/TS Mod/InventedWeather.esp');
    const diagnostic = present(list[0], 'the sole diagnostic published for InventedWeather.esp');
    expect(diagnostic.message).toBe('REGN … — fixed-size-subrecord-short, repairable (lossless): …');
    expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning);
  });

  it('publishes nothing for a plugin with no file', () => {
    const collection = new FakeDiagnosticCollection();
    const clear = vi.spyOn(collection, 'clear');

    publishPluginWarnings(collection, pluginFilesFrom({}), [report('Ghost.esp', 'Gone', 'bad')]);

    expect(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)).toEqual([]);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('replaces the previous scan wholesale — one scan answers for the whole load order', () => {
    const collection = new FakeDiagnosticCollection();
    const clear = vi.spyOn(collection, 'clear');
    const files = pluginFilesFrom({ 'M/A.esp': '/i/mods/M/A.esp', 'M/B.esp': '/i/mods/M/B.esp' });
    publishPluginWarnings(collection, files, [report('A.esp', 'M', 'old')]);

    publishPluginWarnings(collection, files, [report('B.esp', 'M', 'new')]);

    expect(clear).toHaveBeenCalledTimes(2);
    expect(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection).map(([path]) => path)).toEqual(['/i/mods/M/B.esp']);
  });

  it('groups several diagnoses on one plugin under one file entry', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginWarnings(collection, pluginFilesFrom({ 'M/A.esp': '/i/mods/M/A.esp' }), [
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'),
    ]);

    const [, groupedDiagnostics] = present(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)[0], 'the sole grouped diagnostic-collection entry');
    expect(groupedDiagnostics.map((d) => d.message)).toEqual(['first', 'second']);
  });
});
