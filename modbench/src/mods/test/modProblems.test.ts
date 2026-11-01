import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import type { InstanceValue } from '../../instanceLoader/instance';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';
import { ModProblems } from '../modProblems';

const packaged = status;
const FOLDER = '/instance/mods/ModA';
const OTHER = '/instance/mods/ModB';

function over(initial: readonly ModStatus[], plugins: InstanceValue['plugins'] = []) {
  let held = new Map(initial.map((one) => [one.mod, one]));
  const lastGood = new Map(initial.map((one) => [one.mod, one]));
  let changed = (): void => undefined;
  const statuses = { current: () => Promise.resolve(held), of: (mod: string) => lastGood.get(mod), onDidChange: (listener: () => void) => { changed = listener; return { dispose: () => undefined }; } };
  const instance = new FakeInstance(instanceValueFixture({ plugins, modFolders: [{ kind: 'mod', name: 'ModA', modName: 'ModA', path: FOLDER }, { kind: 'mod', name: 'ModB', modName: 'ModB', path: OTHER }] }));
  const collection = new FakeDiagnosticCollection();
  new ModProblems(collection, instance, statuses);
  return { collection, becomes: (next: readonly ModStatus[]) => {
    held = new Map(next.map((one) => [one.mod, one]));
    for (const one of next.filter(({ unreadable }) => unreadable === undefined)) lastGood.set(one.mod, one);
    changed();
  } };
}

const messagesOn = (collection: FakeDiagnosticCollection, file: string) => (collection.get(Uri.file(file)) ?? []).map(({ message, severity }) => [message, severity]);

describe('the Problems panel follows Mod status (modlist-repository.md, Status, story 2)', () => {
  it('shows a warning on the folder of a mod with no manifest', async () => {
    const { collection } = over([packaged('ModA', { noManifest: true })]);

    await vi.waitFor(() => { expect(messagesOn(collection, FOLDER)).toEqual([['No manifest.', DiagnosticSeverity.Warning]]); });
  });

  it('clears a problem when the state stops holding', async () => {
    const { collection, becomes } = over([packaged('ModA', { noManifest: true })]);
    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(true); });

    becomes([packaged('ModA')]);

    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(false); });
  });

  it('keeps the problems of the last good read when a mod\'s status cannot be read', async () => {
    const { collection, becomes } = over([packaged('ModA', { noManifest: true })]);
    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(true); });

    becomes([packaged('ModA', { unreadable: 'EACCES' })]);
    becomes([packaged('ModA', { unreadable: 'EACCES' }), packaged('ModB', { noManifest: true })]);

    await vi.waitFor(() => { expect(collection.has(Uri.file(OTHER))).toBe(true); });
    expect(messagesOn(collection, FOLDER)).toEqual([['No manifest.', DiagnosticSeverity.Warning]]);
  });

  it('shows nothing for a mod whose folder the instance does not hold', async () => {
    const { collection, becomes } = over([]);

    becomes([packaged('Ghost', { noManifest: true }), packaged('ModA', { noManifest: true })]);

    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(true); });
    expect(collection.has(Uri.file('/instance/mods/Ghost'))).toBe(false);
  });

  describe('a mod with several packages (Status, story 6)', () => {
    const manifestFile = `${FOLDER}/MOD.Manifest.json`;
    const several = { manifestFile, packages: [{ kind: 'installationFile' as const, name: 'A.7z', size: 1, hash: 'AAAAAAAAAAA=' }, { kind: 'gameFolder' as const }] };

    it('shows Information on its manifest that names the packages and says an upgrade replaces every one', async () => {
      const { collection } = over([packaged('ModA', several)]);

      await vi.waitFor(() => { expect(messagesOn(collection, manifestFile)).toEqual([[
        "Made from several packages. An upgrade replaces the files of every one of the 2 packages: installation file 'A.7z', the game folder.", DiagnosticSeverity.Information]]); });
    });

    it('points at init source mod when the mod holds a plugin', async () => {
      const { collection } = over([packaged('ModA', several)], [{ name: 'A.esp', path: `${FOLDER}/A.esp`, origin: 'ModA', line: 0, enabled: true, winning: true }]);

      await vi.waitFor(() => { expect(messagesOn(collection, manifestFile)[0]?.[0]).toMatch(/Init Source Mod/); });
    });

    it('points at init source mod for a disabled mod\'s plugin, which the plugin list holds unlisted and not winning', async () => {
      const { collection } = over([packaged('ModA', several)], [{ name: 'A.esp', path: `${FOLDER}/A.esp`, origin: 'ModA', line: null, enabled: false, winning: false }]);

      await vi.waitFor(() => { expect(messagesOn(collection, manifestFile)[0]?.[0]).toMatch(/Init Source Mod/); });
    });

    it('points at no init source mod for a source mod, which the gesture is not offered on', async () => {
      const source = { manifestFile, packages: [{ kind: 'repository' as const, name: 'src' }, { kind: 'gameFolder' as const }] };
      const { collection } = over([packaged('ModA', source)], [{ name: 'A.esp', path: `${FOLDER}/A.esp`, origin: 'ModA', line: 0, enabled: true, winning: true }]);

      await vi.waitFor(() => { expect(messagesOn(collection, manifestFile)[0]?.[0]).toMatch(/^Made from several packages/); });
      expect(messagesOn(collection, manifestFile)[0]?.[0]).not.toMatch(/Decompile/);
    });

    it('shows nothing for a mod of one package', async () => {
      const { collection } = over([packaged('ModA', { manifestFile, packages: [{ kind: 'gameFolder' }] })]);

      await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(false); });
      expect(collection.has(Uri.file(manifestFile))).toBe(false);
    });
  });
});
