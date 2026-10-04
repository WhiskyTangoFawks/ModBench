import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, fakeUri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, Range, DiagnosticSeverity, Uri: { file: fakeUri } }));

import { publishPluginWarnings } from '../loadDiagnostics';
import { originFiles, type OriginFilesOf } from '../../instanceLoader/loadOrderSnapshot';
import type { PluginDiagnosisReport } from '../../client';
import { present } from '../../ports/present';

const report = (plugin: string, origin: string, text: string): PluginDiagnosisReport => ({
  plugin, origin, anchor: null, defectClass: 'fixed-size-subrecord-short', tail: null, message: 'm', text,
});

function entriesAsFsPathAndDiagnosticsInInsertionOrder(collection: FakeDiagnosticCollection) {
  return [...collection].map(([uri, diagnostics]) => [uri.fsPath, diagnostics] as const);
}

// The instance value's rows, one plugin file in each origin's folder.
const originFilesFrom = (folders: Record<string, string>): OriginFilesOf => (origin) => originFiles(
  Object.entries(folders).map(([rowOrigin, folder]) => ({ origin: rowOrigin, path: `${folder}/Any.esp` })), origin);

describe('publishPluginWarnings', () => {
  it('targets the plugin binary itself (pre-Track), carries the refusal wording verbatim, and warns rather than errors since a Malformed plugin still loads and plays', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginWarnings(collection, originFilesFrom({ 'TS Mod': '/instance/mods/TS Mod' }), [
      report('TrueStorms.esp', 'TS Mod', 'REGN … — fixed-size-subrecord-short, repairable (lossless): …'),
    ]);

    const [path, list] = present(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)[0], 'the sole published diagnostic-collection entry');
    expect(path).toBe('/instance/mods/TS Mod/TrueStorms.esp');
    const diagnostic = present(list[0], 'the sole diagnostic published for TrueStorms.esp');
    expect(diagnostic.message).toBe('REGN … — fixed-size-subrecord-short, repairable (lossless): …');
    expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning);
  });

  it('targets the overwrite folder for an overwrite-origin plugin, not the mods/overwrite path that does not exist', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginWarnings(collection, originFilesFrom({ overwrite: '/instance/overwrite' }), [
      report('Stray.esp', 'overwrite', 'bad'),
    ]);

    expect(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection).map(([path]) => path)).toEqual(['/instance/overwrite/Stray.esp']);
  });

  it('publishes nothing for an origin the value has no folder for', () => {
    const collection = new FakeDiagnosticCollection();
    const clear = vi.spyOn(collection, 'clear');

    publishPluginWarnings(collection, originFilesFrom({}), [report('Ghost.esp', 'Gone', 'bad')]);

    expect(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)).toEqual([]);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('replaces the previous scan wholesale — one scan answers for the whole load order', () => {
    const collection = new FakeDiagnosticCollection();
    const clear = vi.spyOn(collection, 'clear');
    const files = originFilesFrom({ M: '/i/mods/M' });
    publishPluginWarnings(collection, files, [report('A.esp', 'M', 'old')]);

    publishPluginWarnings(collection, files, [report('B.esp', 'M', 'new')]);

    expect(clear).toHaveBeenCalledTimes(2);
    expect(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection).map(([path]) => path)).toEqual(['/i/mods/M/B.esp']);
  });

  it('groups several diagnoses on one plugin under one file entry', () => {
    const collection = new FakeDiagnosticCollection();

    publishPluginWarnings(collection, originFilesFrom({ M: '/i/mods/M' }), [
      report('A.esp', 'M', 'first'), report('A.esp', 'M', 'second'),
    ]);

    const [, groupedDiagnostics] = present(entriesAsFsPathAndDiagnosticsInInsertionOrder(collection)[0], 'the sole grouped diagnostic-collection entry');
    expect(groupedDiagnostics.map((d) => d.message)).toEqual(['first', 'second']);
  });
});
