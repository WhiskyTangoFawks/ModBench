import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, uriParse, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, Range, DiagnosticSeverity, Uri: { ...Uri, parse: uriParse } }));

import { decompileAndRepairLink, publishPluginProblems } from '../loadDiagnostics';
import type { PluginAddress, PluginDiagnosisReport } from '../../client';
import { present } from '../../ports/present';

const report = (plugin: string, origin: string, text: string): PluginDiagnosisReport => ({
  plugin, origin, anchor: null, message: 'm', text,
});

function entriesAsFsPathAndDiagnosticsInInsertionOrder(collection: FakeDiagnosticCollection) {
  return [...collection].map(([uri, diagnostics]) => [uri.fsPath, diagnostics] as const);
}

const pluginFilesFrom = (files: Record<string, string>) => ({ name, origin }: PluginAddress): string | undefined =>
  files[`${origin}/${name}`];

describe('publishPluginProblems', () => {
  it('targets the plugin binary itself (before decompile and commit), carries the refusal wording verbatim, at the severity it is given', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginProblems(collection, pluginFilesFrom({ 'TS Mod/InventedWeather.esp': '/instance/mods/TS Mod/InventedWeather.esp' }), [
      report('InventedWeather.esp', 'TS Mod', 'REGN … — fixed-size-subrecord-short, repairable (lossless): …'),
    ], DiagnosticSeverity.Error);

    const [path, list] = present(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)[0], 'the sole published diagnostic-collection entry');
    expect(path).toBe('/instance/mods/TS Mod/InventedWeather.esp');
    const diagnostic = present(list[0], 'the sole diagnostic published for InventedWeather.esp');
    expect(diagnostic.message).toBe('REGN … — fixed-size-subrecord-short, repairable (lossless): …');
    expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
  });

  it('publishes nothing for a plugin with no file', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginProblems(collection, pluginFilesFrom({}), [report('Ghost.esp', 'Gone', 'bad')], DiagnosticSeverity.Warning);

    expect(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)).toEqual([]);
  });

  it('replaces the previous scan wholesale — one scan answers for the whole load order', () => {
    const collection = new FakeDiagnosticCollection();
    const files = pluginFilesFrom({ 'M/A.esp': '/i/mods/M/A.esp', 'M/B.esp': '/i/mods/M/B.esp' });
    publishPluginProblems(collection, files, [report('A.esp', 'M', 'old')], DiagnosticSeverity.Warning);

    publishPluginProblems(collection, files, [report('B.esp', 'M', 'new')], DiagnosticSeverity.Warning);

    expect(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection).map(([path]) => path)).toEqual(['/i/mods/M/B.esp']);
  });

  it('gives each plugin\'s diagnoses the code it is given for that plugin', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginProblems(collection, pluginFilesFrom({ 'M/A.esp': '/i/mods/M/A.esp' }), [report('A.esp', 'M', 'malformed')], DiagnosticSeverity.Warning,
      ({ name, origin }) => `${origin}/${name}`);

    const [, diagnostics] = present(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)[0], 'the sole diagnostic-collection entry');
    expect(diagnostics.map((d) => d.code)).toEqual(['M/A.esp']);
  });

  it.each(['inSourceMod', 'inNonSourceMod'] as const)('links a Malformed entry of a plugin %s to decompile and repair of that plugin', (place) => {
    const plugin = { name: 'A.esp', origin: 'M' };

    expect(decompileAndRepairLink(plugin, place)).toEqual({
      value: 'decompile and repair',
      target: uriParse(`command:modbench.plugin.decompileAndRepair?${encodeURIComponent(JSON.stringify([plugin]))}`),
    });
  });

  it.each([['the game folder', undefined], ['Overwrite', 'inOverwrite']] as const)('offers no link on a plugin in %s, since no mod can hold its source', (_label, place) => {
    expect(decompileAndRepairLink({ name: 'A.esp', origin: 'Data/' }, place)).toBeUndefined();
  });

  it('groups several diagnoses on one plugin under one file entry', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginProblems(collection, pluginFilesFrom({ 'M/A.esp': '/i/mods/M/A.esp' }), [
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'),
    ], DiagnosticSeverity.Warning);

    const [, groupedDiagnostics] = present(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)[0], 'the sole grouped diagnostic-collection entry');
    expect(groupedDiagnostics.map((d) => d.message)).toEqual(['first', 'second']);
  });
});
