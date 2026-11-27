import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { DiagnosticSeverity, Uri, type FakeDiagnosticCollection } from '../../test/vscodeMock';
import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import type { InstanceValue } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';
import { HeldModStatuses } from '../../test/heldModStatuses';

const chainsSettled = () => new Promise((resolve) => setImmediate(resolve));

const packaged = status;
const FOLDER = '/instance/mods/ModA';
const OTHER = '/instance/mods/ModB';

function over(initial: readonly ModStatus[], plugins: InstanceValue['plugins'] = []) {
  const statuses = new HeldModStatuses();
  statuses.answer(initial);
  const { diagnostics } = modsViewOn({
    value: instanceValueFixture({ plugins, modFolders: [{ kind: 'mod', name: 'ModA', modName: 'ModA', path: FOLDER }, { kind: 'mod', name: 'ModB', modName: 'ModB', path: OTHER }] }),
    statuses,
  });
  return { collection: diagnostics('modbench-mod-status'), becomes: (next: readonly ModStatus[]) => { statuses.answer(next); } };
}

const messagesOn = (collection: FakeDiagnosticCollection, file: string) => (collection.get(Uri.file(file)) ?? []).map(({ message, severity }) => [message, severity]);

describe('the Problems panel follows Mod status (instance-repository.md, Status, story 2)', () => {
  it('shows a warning on the folder of a mod with no manifest', async () => {
    const { collection } = over([packaged('ModA', { noManifest: true })]);

    await chainsSettled();
    expect(messagesOn(collection, FOLDER)).toEqual([['No manifest.', DiagnosticSeverity.Warning]]);
  });

  it('clears a problem when the state stops holding', async () => {
    const { collection, becomes } = over([packaged('ModA', { noManifest: true })]);
    await chainsSettled();
    expect(collection.has(Uri.file(FOLDER))).toBe(true);

    becomes([packaged('ModA')]);

    await chainsSettled();
    expect(collection.has(Uri.file(FOLDER))).toBe(false);
  });

  it('keeps the problems of the last good read when a mod\'s status cannot be read', async () => {
    const { collection, becomes } = over([packaged('ModA', { noManifest: true })]);
    await chainsSettled();
    expect(collection.has(Uri.file(FOLDER))).toBe(true);

    becomes([packaged('ModA', { unreadable: 'EACCES' })]);
    becomes([packaged('ModA', { unreadable: 'EACCES' }), packaged('ModB', { noManifest: true })]);

    await chainsSettled();
    expect(collection.has(Uri.file(OTHER))).toBe(true);
    expect(messagesOn(collection, FOLDER)).toEqual([['No manifest.', DiagnosticSeverity.Warning]]);
  });

  it('shows only the warning on the manifest of a mod whose manifest cannot be read, not a problem the last good read derived from its absence', async () => {
    const manifestFile = `${FOLDER}/MOD.Manifest.json`;
    const { collection, becomes } = over([packaged('ModA', { noManifest: true })]);
    await chainsSettled();
    expect(collection.has(Uri.file(FOLDER))).toBe(true);

    becomes([packaged('ModA', { manifestFile, unreadable: 'EACCES' })]);

    await chainsSettled();
    expect(messagesOn(collection, manifestFile)).toEqual([['EACCES.', DiagnosticSeverity.Warning]]);
    expect(collection.has(Uri.file(FOLDER))).toBe(false);
  });

  it('shows only the warning on the manifest of a mod whose manifest cannot be read, not a problem the last good read derived from the old manifest', async () => {
    const manifestFile = `${FOLDER}/MOD.Manifest.json`;
    const { collection, becomes } = over([packaged('ModA', { manifestFile, gone: ['PkgA readme.txt'] })]);
    await chainsSettled();
    expect(messagesOn(collection, manifestFile)).toHaveLength(1);

    becomes([packaged('ModA', { manifestFile, unreadable: 'EACCES' })]);

    await chainsSettled();
    expect(messagesOn(collection, manifestFile)).toEqual([['EACCES.', DiagnosticSeverity.Warning]]);
  });

  it('shows a warning on the manifest of a mod whose manifest has been unreadable since the first read', async () => {
    const manifestFile = `${FOLDER}/MOD.Manifest.json`;
    const { collection, becomes } = over([]);

    becomes([packaged('ModA', { manifestFile, unreadable: "its manifest is not valid JSON at line 1: Unexpected token '<'" })]);

    await chainsSettled();
    expect(messagesOn(collection, manifestFile)).toEqual([["Its manifest is not valid JSON at line 1: Unexpected token '<'.", DiagnosticSeverity.Warning]]);
  });

  it('shows nothing for a mod whose folder the instance does not hold', async () => {
    const { collection, becomes } = over([]);

    becomes([packaged('Ghost', { noManifest: true }), packaged('ModA', { noManifest: true })]);

    await chainsSettled();
    expect(collection.has(Uri.file(FOLDER))).toBe(true);
    expect(collection.has(Uri.file('/instance/mods/Ghost'))).toBe(false);
  });

  describe('a mod with several packages (Status, story 6)', () => {
    const manifestFile = `${FOLDER}/MOD.Manifest.json`;
    const several = { manifestFile, packages: [{ kind: 'installationFile' as const, name: 'A.7z', size: 1, hash: 'AAAAAAAAAAA=' }, { kind: 'gameFolder' as const }] };

    it('shows Information on its manifest that names the packages and says an upgrade replaces every one', async () => {
      const { collection } = over([packaged('ModA', several)]);

      await chainsSettled();
      expect(messagesOn(collection, manifestFile)).toEqual([[
        "Made from several packages. An upgrade replaces the files of every one of the 2 packages: installation file 'A.7z', the game folder.", DiagnosticSeverity.Information]]);
    });

    it('points at version in git when the mod holds a plugin', async () => {
      const { collection } = over([packaged('ModA', several)], [{ name: 'A.esp', path: `${FOLDER}/A.esp`, origin: 'ModA', line: 0, enabled: true, winning: true }]);

      await chainsSettled();
      expect(messagesOn(collection, manifestFile)[0]?.[0]).toMatch(/Version in Git/);
    });

    it('points at version in git for a disabled mod\'s plugin, which the plugin list holds unlisted and not winning', async () => {
      const { collection } = over([packaged('ModA', several)], [{ name: 'A.esp', path: `${FOLDER}/A.esp`, origin: 'ModA', line: null, enabled: false, winning: false }]);

      await chainsSettled();
      expect(messagesOn(collection, manifestFile)[0]?.[0]).toMatch(/Version in Git/);
    });

    it('points at no version in git for a source mod, which the gesture is not offered on', async () => {
      const source = { manifestFile, packages: [{ kind: 'repository' as const, name: 'src' }, { kind: 'gameFolder' as const }] };
      const { collection } = over([packaged('ModA', source)], [{ name: 'A.esp', path: `${FOLDER}/A.esp`, origin: 'ModA', line: 0, enabled: true, winning: true }]);

      await chainsSettled();
      expect(messagesOn(collection, manifestFile)[0]?.[0]).toMatch(/^Made from several packages/);
      expect(messagesOn(collection, manifestFile)[0]?.[0]).not.toMatch(/Decompile/);
    });
  });
});
