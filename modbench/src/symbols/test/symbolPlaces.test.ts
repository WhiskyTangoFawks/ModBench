import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host, Location, Range, Uri } from './vscodeHost';
import { instanceHolding, symbolsOver } from './symbolsOver';
import type { EntryNames, PlaceInFile } from '../../symbolNames/symbolNames';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const MODLIST = '/profiles/Default/modlist.txt';
const placeAt = (line: number): PlaceInFile => ({ file: MODLIST, start: { line, character: 1 }, end: { line, character: 9 } });
const at = (line: number) => new Location(Uri.file(MODLIST), new Range(line, 1, line, 9));
const UNREAD = '/userlist.yaml: it does not read';
const reading = (lines: number[], leftOut: string[] = []) => ({ references: lines.map(placeAt), leftOut });

function referencedBy(readings: ReturnType<typeof reading>[], name = 'Base Mod') {
  const owner: EntryNames = { listed: () => Promise.resolve([]), read: () => Promise.resolve(readings.shift() ?? reading([])), nameAt: () => Promise.resolve(undefined) };
  const instance = instanceHolding(instanceValueFixture({ mods: [{ kind: 'mod', name: 'Base Mod', enabled: true }] }));
  const made = symbolsOver({ instance, entryOwners: [owner] });
  host.holds([document(MODLIST, '+Base Mod\n'.repeat(8))]);
  return { ...made, instance, shown: host.run('modbench.symbol.referencedBy', { argument: { kind: 'mod', name } }) };
}

const listed = async () => {
  const [input] = host.referencesShown;
  await input?.resolve();
  return input?.resolve();
};

describe('referenced by lists the places in VS Code\'s References view (commands.md, `referenced by` under Symbol)', () => {
  it('titles the list with its subject, under its context value, anchored at the first place', async () => {
    await referencedBy([reading([2, 4])]).shown;

    expect(host.referencesShown).toEqual([expect.objectContaining({ title: 'Referenced By: Base Mod', contextValue: 'modbench.modReferencedBy', location: at(2) })]);
  });

  it('notifies of each file it could not read, a gesture that landed in part (common.md, Reporting)', async () => {
    const { reporter, shown } = referencedBy([reading([2], [UNREAD, '/b: gone'])]);
    await shown;

    expect([reporter.reports, reporter.shownFailures]).toEqual([[{
      severity: 'warning', message: 'Referenced by on Base Mod could not read every file that may name it.', detail: `${UNREAD}\n/b: gone`,
    }], []]);
  });

  it.each([
    ['no file names it', [], 'No file names it.'],
    ['no file that could be read names it', [UNREAD], 'No file that could be read names it.'],
  ])('says that %s, which leaves the view where it was', async (_case, unread, why) => {
    const { reporter, shown } = referencedBy([reading([], unread)]);
    await shown;

    expect([host.referencesShown, reporter.reports.filter(({ severity }) => severity === 'error').map(({ message, detail }) => [message, detail])])
      .toEqual([[], [['Could not list where files name Base Mod.', why]]]);
  });

  it('says why it cannot list, where the symbol names nothing', async () => {
    const { reporter, shown } = referencedBy([reading([2])], 'Gone Mod');
    await shown;

    expect([host.referencesShown, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', 'Mods lists no mod named Gone Mod.']]]);
  });
});

describe('the line above the list, read again (common.md, States, story 3)', () => {
  it.each([
    { found: [], unread: [], message: 'No references found.' },
    { found: [], unread: [UNREAD], message: 'No references found in the files that could be read.' },
    { found: [0, 1], unread: [UNREAD], message: undefined },
  ])('is $message where $found.length places are found and $unread.length files are unread', async ({ found, unread, message }) => {
    await referencedBy([reading([0]), reading(found, unread)]).shown;

    expect((await listed())?.message).toBe(message);
  });

  it('says why, and lists nothing, where the symbol names nothing on the read again', async () => {
    const { instance, reporter, shown } = referencedBy([reading([0])]);
    await shown;
    instance.land(instanceValueFixture({ mods: [] }));

    expect([(await listed())?.message, reporter.reports.map(({ detail }) => detail)]).toEqual(['No references found in the files that could be read.', ['Mods lists no mod named Base Mod.']]);
  });
});
