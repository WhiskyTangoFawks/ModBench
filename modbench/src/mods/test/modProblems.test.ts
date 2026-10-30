import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';
import { ModProblems } from '../modProblems';

const FOLDER = '/instance/mods/ModA';

function over(initial: readonly ModStatus[]) {
  let held = new Map(initial.map((one) => [one.mod, one]));
  let changed = (): void => undefined;
  const statuses = { current: () => Promise.resolve(held), onDidChange: (listener: () => void) => { changed = listener; return { dispose: () => undefined }; } };
  const instance = new FakeInstance(instanceValueFixture({ modFolders: [{ kind: 'mod', name: 'ModA', modName: 'ModA', path: FOLDER }] }));
  const collection = new FakeDiagnosticCollection();
  new ModProblems(collection, instance, statuses);
  return { collection, becomes: (next: readonly ModStatus[]) => { held = new Map(next.map((one) => [one.mod, one])); changed(); } };
}

const messagesOn = (collection: FakeDiagnosticCollection, file: string) => (collection.get(Uri.file(file)) ?? []).map(({ message, severity }) => [message, severity]);

describe('the Problems panel follows Mod status (modlist-repository.md, Status, story 2)', () => {
  it('shows a warning on the folder of a mod with no manifest', async () => {
    const { collection } = over([status('ModA', { noManifest: true })]);

    await vi.waitFor(() => { expect(messagesOn(collection, FOLDER)).toEqual([['No manifest.', DiagnosticSeverity.Warning]]); });
  });

  it('clears a problem when the state stops holding', async () => {
    const { collection, becomes } = over([status('ModA', { noManifest: true })]);
    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(true); });

    becomes([status('ModA')]);

    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(false); });
  });

  it('shows nothing for a mod whose folder the instance does not hold', async () => {
    const { collection, becomes } = over([]);

    becomes([status('Ghost', { noManifest: true })]);

    await vi.waitFor(() => { expect(collection.has(Uri.file('/instance/mods/Ghost'))).toBe(false); });
  });
});
