import { describe, it, expect } from 'vitest';
import { showOpenRecordCompilable } from '../openRecordCompilable';

// commands.md, compile: Editor, on a tracked and editable plugin. The record tab's compile button
// reads the key this sets from the open record's own plugin.
describe('whether the open record\'s plugin compiles', () => {
  function wired(owners: Record<string, { plugin: string; origin: string } | undefined>, compilable: Set<string>) {
    const shown: boolean[] = [];
    let openRecord: string | undefined;
    const recordListeners: ((formKey: string | undefined) => void)[] = [];
    const factListeners: (() => void)[] = [];
    const pending: (() => void)[] = [];
    const disposable = showOpenRecordCompilable({
      onDidChangeOpenRecord: (listener) => { recordListeners.push(listener); return { dispose: () => undefined }; },
      openRecord: () => openRecord,
      onDidChangeFacts: (listener) => { factListeners.push(listener); return { dispose: () => undefined }; },
      ownerOf: (formKey) => new Promise((resolve) => { pending.push(() => { resolve(owners[formKey]); }); }),
      compilable: (plugin, origin) => compilable.has(`${origin}|${plugin}`),
      show: (value) => shown.push(value),
    });
    // `newestFirst` answers a later question before an earlier one, as a slow read can.
    const settle = async (newestFirst = false) => {
      const answers = pending.splice(0);
      for (const answer of newestFirst ? answers.reverse() : answers) answer();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
      shown, disposable, settle,
      open: (formKey: string | undefined) => { openRecord = formKey; for (const l of recordListeners) l(formKey); },
      factsChanged: () => { for (const l of factListeners) l(); },
    };
  }

  it('is true while the open record\'s plugin compiles, and false for one that does not', async () => {
    const w = wired(
      { 'A:1': { plugin: 'A.esp', origin: 'ModA' }, 'B:1': { plugin: 'B.esp', origin: 'ModB' } }, new Set(['ModA|A.esp']));

    w.open('A:1');
    await w.settle();
    expect(w.shown.at(-1)).toBe(true);

    w.open('B:1');
    await w.settle();
    expect(w.shown.at(-1)).toBe(false);
  });

  it('is false with no record open, or one whose plugin mEdit cannot name', async () => {
    const w = wired({ 'A:1': undefined }, new Set());

    w.open('A:1');
    await w.settle();
    expect(w.shown.at(-1)).toBe(false);

    w.open(undefined);
    await w.settle();
    expect(w.shown.at(-1)).toBe(false);
  });

  it('answers for the record open now, never one an earlier, slower answer was for', async () => {
    const w = wired(
      { 'A:1': { plugin: 'A.esp', origin: 'ModA' }, 'B:1': { plugin: 'B.esp', origin: 'ModB' } }, new Set(['ModA|A.esp']));

    w.open('A:1');
    w.open('B:1');
    await w.settle(true);

    expect(w.shown.at(-1)).toBe(false);
  });

  it('is asked again when the plugin facts change, a Track or a reconcile among them', async () => {
    const compilable = new Set<string>();
    const w = wired({ 'A:1': { plugin: 'A.esp', origin: 'ModA' } }, compilable);
    w.open('A:1');
    await w.settle();
    expect(w.shown.at(-1)).toBe(false);

    compilable.add('ModA|A.esp');
    w.factsChanged();
    await w.settle();

    expect(w.shown.at(-1)).toBe(true);
  });
});
