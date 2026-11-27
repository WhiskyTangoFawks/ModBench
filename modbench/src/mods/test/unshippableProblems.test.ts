import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { DiagnosticSeverity, Range, Uri, type FakeDiagnosticCollection } from '../../test/vscodeMock';
import type { FileRead, PublisherConfiguration } from '../../instanceAdapter/instanceAdapter';
import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';
import { HeldModStatuses } from '../../test/heldModStatuses';

const chainsSettled = () => new Promise((resolve) => setImmediate(resolve));

const SETTINGS = '/instance/compiler_settings.json';
const FOLDER = '/instance/mods/ModA';
const REASON = 'nothing ships it';

const configuration = (shippable: (path: string) => boolean = () => false): PublisherConfiguration => ({
  kind: 'read', covering: () => [], listed: () => [], pathProblems: [],
  unshippable: { file: SETTINGS, reason: (folder, path, mod, heldByPackage, entries) => (heldByPackage || shippable(`${folder}/${path}`) ? undefined : `${mod} ${REASON}${entries?.kind === 'read' ? ` ${entries.answer.join(',')}` : ''}`) },
});

type Entries = ReadonlyMap<string, FileRead<readonly string[]>>;

function over(initial: readonly ModStatus[], publisherConfiguration: PublisherConfiguration, packaged: Record<string, readonly string[]> = {}, entries: Record<string, Entries> = {}) {
  const statuses = new HeldModStatuses();
  statuses.answer(initial, { packaged, entries });
  const { instance, diagnostics } = modsViewOn({
    value: instanceValueFixture({
      publisherConfiguration, modFolders: [{ kind: 'mod', name: 'ModA', modName: 'ModA', path: FOLDER }, { kind: 'mod', name: 'ModB', modName: 'ModB', path: '/instance/mods/ModB' }],
    }),
    statuses,
  });
  return {
    collection: diagnostics('modbench-unshippable'), instance,
    becomes: (next: readonly ModStatus[], nextPackaged?: Record<string, readonly string[]>, nextEntries?: Record<string, Entries>) => {
      statuses.answer(next, { packaged: nextPackaged, entries: nextEntries });
    },
  };
}

const problemsOn = (collection: FakeDiagnosticCollection) => (collection.get(Uri.file(SETTINGS)) ?? []).map(({ range, message, severity }) => [range, message, severity]);
const firstLine = new Range(0, 0, 0, Number.MAX_SAFE_INTEGER);

describe('a mod the published modlist has no way to ship (publishing.md, What ships, story 2)', () => {
  it('is one warning on the publisher\'s configuration, naming the mod, how many files, the first, and why', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp', 'b.esp', 'sub/c.dds'] })], configuration());

    await chainsSettled();
    expect(problemsOn(collection)).toEqual([[firstLine, `3 files of "ModA" have no way to ship, such as 'a.esp': ModA ${REASON}.`, DiagnosticSeverity.Warning]]);
  });

  it('judges an archive by the entries no package holds, and judges it again when they change', async () => {
    const { collection, becomes } = over([status('ModA', { unpackaged: ['a.ba2'] })], configuration(), {}, { ModA: new Map([['a.ba2', { kind: 'read', answer: ['x.dds'] }]]) });
    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'a.ba2': ModA ${REASON} x.dds.`]);

    becomes([status('ModA', { unpackaged: ['a.ba2'] })], {}, { ModA: new Map([['a.ba2', { kind: 'read', answer: ['y.dds'] }]]) });

    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'a.ba2': ModA ${REASON} y.dds.`]);
  });

  it('says a single file without "such as"', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp'] })], configuration());

    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'a.esp': ModA ${REASON}.`]);
  });

  it('counts and names only the files the publisher judges unshippable, each judged by its path in the instance', async () => {
    const { collection } = over([status('ModA', { unpackaged: ['a.esp', 'b.esp'] })], configuration((path) => path === `${FOLDER}/a.esp`));

    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'b.esp': ModA ${REASON}.`]);
  });

  it('names no file one of the mod\'s packages holds, and judges again when the files its packages hold change', async () => {
    const { collection, becomes } = over([status('ModA', { unpackaged: ['a.esp', 'b.esp'] })], configuration(), { ModA: ['a.esp'] });
    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModA" has no way to ship: 'b.esp': ModA ${REASON}.`]);

    becomes([status('ModA', { unpackaged: ['a.esp', 'b.esp'] })], { ModA: [] });

    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toEqual([`2 files of "ModA" have no way to ship, such as 'a.esp': ModA ${REASON}.`]);
  });

  it('is one warning for each mod that has such a file, and none for a mod with none', async () => {
    const { collection } = over([status('ModA'), status('ModB', { unpackaged: ['a.esp'] })], configuration());

    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toEqual([`1 file of "ModB" has no way to ship: 'a.esp': ModB ${REASON}.`]);
  });

  it('judges again only the mods whose status changed', async () => {
    const judgedMods: string[] = [];
    const counting: PublisherConfiguration = {
      kind: 'read', covering: () => [], listed: () => [], pathProblems: [],
      unshippable: { file: SETTINGS, reason: (_folder, _path, mod) => { judgedMods.push(mod); return REASON; } },
    };
    const { collection, becomes } = over([status('ModA', { unpackaged: ['a.esp'] }), status('ModB', { unpackaged: ['b.esp'] })], counting);
    await chainsSettled();
    expect(problemsOn(collection)).toHaveLength(2);
    judgedMods.length = 0;

    becomes([status('ModA', { unpackaged: ['a.esp'] }), status('ModB', { unpackaged: ['b.esp', 'c.esp'] })]);
    await chainsSettled();
    expect(problemsOn(collection).map(([, message]) => message)).toContain(`2 files of "ModB" have no way to ship, such as 'b.esp': ${REASON}.`);

    expect(judgedMods).toEqual(['ModB', 'ModB']);
  });

  it('follows the statuses, and clears when the instance holds no publisher', async () => {
    const { collection, instance, becomes } = over([status('ModA', { unpackaged: ['a.esp'] })], configuration());
    await chainsSettled();
    expect(problemsOn(collection)).toHaveLength(1);

    becomes([status('ModA')]);
    await chainsSettled();
    expect(problemsOn(collection)).toHaveLength(0);
    becomes([status('ModA', { unpackaged: ['a.esp'] })]);
    await chainsSettled();
    expect(problemsOn(collection)).toHaveLength(1);
    instance.publish({ ...instance.value, publisherConfiguration: { kind: 'none' } });

    await chainsSettled();
    expect(problemsOn(collection)).toHaveLength(0);
  });
});
