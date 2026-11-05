import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import type { PublisherConfiguration } from '../../instanceAdapter/instanceAdapter';
import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';
import { UnshippableProblems } from '../unshippableProblems';

const SETTINGS = '/instance/compiler_settings.json';
const FOLDER = '/instance/mods/ModA';
const REASON = 'nothing ships it';

const configuration = (shippable: (path: string) => boolean = () => false): PublisherConfiguration => ({
  kind: 'read', covering: () => [], listed: () => [], pathProblems: [],
  unshippable: { file: SETTINGS, reason: (folder, path, mod) => (shippable(`${folder}/${path}`) ? undefined : `${mod} ${REASON}`) },
});

function over(initial: readonly ModStatus[], publisherConfiguration: PublisherConfiguration) {
  let held = new Map(initial.map((one) => [one.mod, one]));
  let changed = (): void => undefined;
  const statuses = { current: () => Promise.resolve(held), onDidChange: (listener: () => void) => { changed = listener; return { dispose: () => undefined }; } };
  const instance = new FakeInstance(instanceValueFixture({
    publisherConfiguration, modFolders: [{ kind: 'mod', name: 'ModA', modName: 'ModA', path: FOLDER }, { kind: 'mod', name: 'ModB', modName: 'ModB', path: '/instance/mods/ModB' }],
  }));
  const collection = new FakeDiagnosticCollection();
  new UnshippableProblems(collection, instance, statuses);
  return {
    collection, instance,
    becomes: (next: readonly ModStatus[]) => { held = new Map(next.map((one) => [one.mod, one])); changed(); },
  };
}

const problemsOn = (collection: FakeDiagnosticCollection) => (collection.get(Uri.file(SETTINGS)) ?? []).map(({ range, message, severity }) => [range, message, severity]);
const firstLine = new Range(0, 0, 0, Number.MAX_SAFE_INTEGER);

describe('a mod the published modlist has no way to ship (publishing.md, What ships, story 2)', () => {
  it('is one warning on the publisher\'s configuration, naming the mod, how many files, the first, and why', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp', 'b.esp', 'sub/c.dds'] })], configuration());

    await vi.waitFor(() => {
      expect(problemsOn(collection)).toEqual([[firstLine, `3 files of "ModA" have no way to ship, such as 'a.esp': ModA ${REASON}.`, DiagnosticSeverity.Warning]]);
    });
  });

  it('says a single file without "such as"', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp'] })], configuration());

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'a.esp': ModA ${REASON}.`]); });
  });

  it('counts and names only the files the publisher judges unshippable, each judged by its path in the instance', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp', 'b.esp'] })], configuration((path) => path === `${FOLDER}/a.esp`));

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'b.esp': ModA ${REASON}.`]); });
  });

  it('is one warning for each mod that has such a file, and none for a mod with none', async () => {
    const { collection } = over([status('ModA'), status('ModB', { unpackaged: ['a.esp'] })], configuration());

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModB" has no way to ship: 'a.esp': ModB ${REASON}.`]); });
  });

  it('follows the statuses, and clears when the instance holds no publisher', async () => {
    const { collection, instance, becomes } = over([status('ModA', { unpackaged: ['a.esp'] })], configuration());
    await vi.waitFor(() => { expect(problemsOn(collection)).toHaveLength(1); });

    becomes([status('ModA')]);
    await vi.waitFor(() => { expect(problemsOn(collection)).toHaveLength(0); });
    becomes([status('ModA', { unpackaged: ['a.esp'] })]);
    await vi.waitFor(() => { expect(problemsOn(collection)).toHaveLength(1); });
    instance.publish({ ...instance.value, publisherConfiguration: { kind: 'none' } });

    await vi.waitFor(() => { expect(problemsOn(collection)).toHaveLength(0); });
  });
});
