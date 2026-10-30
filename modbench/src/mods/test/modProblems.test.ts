import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';
import { ModProblems } from '../modProblems';

const FOLDER = '/instance/mods/ModA';
const OTHER = '/instance/mods/ModB';

function over(initial: readonly ModStatus[]) {
  let held = new Map(initial.map((one) => [one.mod, one]));
  const lastGood = new Map(initial.map((one) => [one.mod, one]));
  let changed = (): void => undefined;
  const statuses = { current: () => Promise.resolve(held), of: (mod: string) => lastGood.get(mod), onDidChange: (listener: () => void) => { changed = listener; return { dispose: () => undefined }; } };
  const instance = new FakeInstance(instanceValueFixture({ modFolders: [{ kind: 'mod', name: 'ModA', modName: 'ModA', path: FOLDER }, { kind: 'mod', name: 'ModB', modName: 'ModB', path: OTHER }] }));
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
    const { collection } = over([status('ModA', { noManifest: true })]);

    await vi.waitFor(() => { expect(messagesOn(collection, FOLDER)).toEqual([['No manifest.', DiagnosticSeverity.Warning]]); });
  });

  it('clears a problem when the state stops holding', async () => {
    const { collection, becomes } = over([status('ModA', { noManifest: true })]);
    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(true); });

    becomes([status('ModA')]);

    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(false); });
  });

  it('keeps the problems of the last good read when a mod\'s status cannot be read', async () => {
    const { collection, becomes } = over([status('ModA', { noManifest: true })]);
    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(true); });

    becomes([status('ModA', { unreadable: 'EACCES' })]);
    becomes([status('ModA', { unreadable: 'EACCES' }), status('ModB', { noManifest: true })]);

    await vi.waitFor(() => { expect(collection.has(Uri.file(OTHER))).toBe(true); });
    expect(messagesOn(collection, FOLDER)).toEqual([['No manifest.', DiagnosticSeverity.Warning]]);
  });

  it('shows nothing for a mod whose folder the instance does not hold', async () => {
    const { collection, becomes } = over([]);

    becomes([status('Ghost', { noManifest: true }), status('ModA', { noManifest: true })]);

    await vi.waitFor(() => { expect(collection.has(Uri.file(FOLDER))).toBe(true); });
    expect(collection.has(Uri.file('/instance/mods/Ghost'))).toBe(false);
  });
});
