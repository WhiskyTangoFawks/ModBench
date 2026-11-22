import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import type { FileRead, PublisherConfiguration } from '../../instanceAdapter/instanceAdapter';
import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';
import { UnshippableProblems } from '../unshippableProblems';
import { holdingRedraws } from '../../drivingLib/heldRedraw';
import { MODS_KEY_ARGS } from '../gestureEntry';

const SETTINGS = '/instance/compiler_settings.json';
const FOLDER = '/instance/mods/ModA';
const REASON = 'nothing ships it';

const configuration = (shippable: (path: string) => boolean = () => false): PublisherConfiguration => ({
  kind: 'read', covering: () => [], listed: () => [], pathProblems: [],
  unshippable: { file: SETTINGS, reason: (folder, path, mod, heldByPackage, entries) => (heldByPackage || shippable(`${folder}/${path}`) ? undefined : `${mod} ${REASON}${entries?.kind === 'read' ? ` ${entries.answer.join(',')}` : ''}`) },
});

type Entries = ReadonlyMap<string, FileRead<readonly string[]>>;

function over(initial: readonly ModStatus[], publisherConfiguration: PublisherConfiguration, packaged: Record<string, readonly string[]> = {}, entriesOf: Record<string, Entries> = {}) {
  let held = new Map(initial.map((one) => [one.mod, one]));
  let changed = (): void => undefined;
  let heldByPackage = packaged;
  let entries = entriesOf;
  const statuses = {
    current: () => Promise.resolve(held), heldByPackage: (mod: string): ReadonlySet<string> => new Set(heldByPackage[mod] ?? []),
    entriesNoPackageHolds: (mod: string): Entries => entries[mod] ?? new Map(), onDidChange: (listener: (mods: 'every' | ReadonlySet<string>) => void) => { changed = () => { listener('every'); }; return { dispose: () => undefined }; },
  };
  const instance = new FakeInstance(instanceValueFixture({
    publisherConfiguration, modFolders: [{ kind: 'mod', name: 'ModA', modName: 'ModA', path: FOLDER }, { kind: 'mod', name: 'ModB', modName: 'ModB', path: '/instance/mods/ModB' }],
  }));
  const collection = new FakeDiagnosticCollection();
  new UnshippableProblems(collection, instance, statuses);
  return {
    collection, instance,
    becomes: (next: readonly ModStatus[], nextPackaged: Record<string, readonly string[]> = heldByPackage, nextEntries: Record<string, Entries> = entries) => {
      entries = nextEntries;
      held = new Map(next.map((one) => [one.mod, one]));
      heldByPackage = nextPackaged;
      changed();
    },
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

  it('judges an archive by the entries no package holds, and judges it again when they change', async () => {
    const { collection, becomes } = over([status('ModA', { unpackaged: ['a.ba2'] })], configuration(), {}, { ModA: new Map([['a.ba2', { kind: 'read', answer: ['x.dds'] }]]) });
    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'a.ba2': ModA ${REASON} x.dds.`]); });

    becomes([status('ModA', { unpackaged: ['a.ba2'] })], {}, { ModA: new Map([['a.ba2', { kind: 'read', answer: ['y.dds'] }]]) });

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'a.ba2': ModA ${REASON} y.dds.`]); });
  });

  it('says a single file without "such as"', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp'] })], configuration());

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'a.esp': ModA ${REASON}.`]); });
  });

  it('counts and names only the files the publisher judges unshippable, each judged by its path in the instance', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp', 'b.esp'] })], configuration((path) => path === `${FOLDER}/a.esp`));

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'b.esp': ModA ${REASON}.`]); });
  });

  it('names no file one of the mod\'s packages holds, and judges again when the files its packages hold change', async () => {
    const { collection, becomes } = over([status('ModA', { unpackaged: ['a.esp', 'b.esp'] })], configuration(), { ModA: ['a.esp'] });
    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'b.esp': ModA ${REASON}.`]); });

    becomes([status('ModA', { unpackaged: ['a.esp', 'b.esp'] })], { ModA: [] });

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`2 files of "ModA" have no way to ship, such as 'a.esp': ModA ${REASON}.`]); });
  });

  it('is one warning for each mod that has such a file, and none for a mod with none', async () => {
    const { collection } = over([status('ModA'), status('ModB', { unpackaged: ['a.esp'] })], configuration());

    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModB" has no way to ship: 'a.esp': ModB ${REASON}.`]); });
  });

  it('judges again only the mods whose status changed', async () => {
    const judgedMods: string[] = [];
    const counting: PublisherConfiguration = {
      kind: 'read', covering: () => [], listed: () => [], pathProblems: [],
      unshippable: { file: SETTINGS, reason: (_folder, _path, mod) => { judgedMods.push(mod); return REASON; } },
    };
    const { collection, becomes } = over([status('ModA', { unpackaged: ['a.esp'] }), status('ModB', { unpackaged: ['b.esp'] })], counting);
    await vi.waitFor(() => { expect(problemsOn(collection)).toHaveLength(2); });
    judgedMods.length = 0;

    becomes([status('ModA', { unpackaged: ['a.esp'] }), status('ModB', { unpackaged: ['b.esp', 'c.esp'] })]);
    await vi.waitFor(() => { expect(problemsOn(collection).map(([, message]) => message)).toContain(`2 files of "ModB" have no way to ship, such as 'b.esp': ${REASON}.`); });

    expect(judgedMods).toEqual(['ModB', 'ModB']);
  });

  it('shows a change at once while a gesture writes from a view (common.md, A view, stories 2 and 14)', async () => {
    const { collection, becomes } = over([status('ModA', { unpackaged: ['a.esp'] })], configuration());
    await vi.waitFor(() => { expect(problemsOn(collection)).toHaveLength(1); });
    let shownWhileWriting = -1;

    await holdingRedraws(MODS_KEY_ARGS.view, async () => {
      becomes([status('ModA')]);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      shownWhileWriting = problemsOn(collection).length;
    });

    await vi.waitFor(() => { expect([shownWhileWriting, problemsOn(collection).length]).toEqual([0, 0]); });
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
