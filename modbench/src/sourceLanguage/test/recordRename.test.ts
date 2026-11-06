import { describe, expect, it } from 'vitest';
import { recordEditAt } from '../recordRename';

const TEXT = '{ "FormKey": "000800:Patch.esp", "EditorID": "PatchNpc", "Race": "000801:Base.esm", "Name": "Npc" }';
const at = (snippet: string) => TEXT.indexOf(snippet) + 2;
const PATCH = { name: 'Patch.esp', origin: 'Patch Mod' };
const BASE = { name: 'Base.esm', origin: 'Base Mod', winning: true };
const plugins = [BASE, { name: 'Base.esm', origin: 'Losing Mod', winning: false }];
const fileHolds = () => Promise.resolve(PATCH);

describe('Rename Symbol on a record is edit field on its FormKey or its EditorID (source.md, In the text editor)', () => {
  it('on a FormKey a record links, changes that FormKey in the copy mod order resolves its plugin to', async () => {
    const found = recordEditAt(TEXT, at('000801'));

    expect(found && { start: found.start, end: found.end, value: found.value }).toEqual({ start: TEXT.indexOf('000801'), end: TEXT.indexOf('000801') + 15, value: '000801:Base.esm' });
    expect(await found?.edit('000900:Base.esm', plugins, fileHolds)).toEqual([
      { formKey: '000801:Base.esm', plugin: 'Base.esm', origin: 'Base Mod' },
      { op: 'set', path: [{ kind: 'member', name: 'FormKey' }], value: '000900:Base.esm' },
    ]);
  });

  it('on the EditorID, changes it in the copy the file holds', async () => {
    const found = recordEditAt(TEXT, at('PatchNpc'));

    expect(found?.value).toBe('PatchNpc');
    expect(await found?.edit('Renamed', plugins, fileHolds)).toEqual([
      { formKey: '000800:Patch.esp', plugin: 'Patch.esp', origin: 'Patch Mod' },
      { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'Renamed' },
    ]);
  });

  it('offers nothing on another field', () => {
    expect(recordEditAt(TEXT, at('"Npc"'))).toBeUndefined();
  });

  it('refuses a FormKey whose plugin mod order resolves to no copy, and an EditorID in a file that holds no record', async () => {
    await expect(recordEditAt(TEXT, at('000801'))?.edit('000900:Base.esm', [], fileHolds)).rejects.toThrow('Mod order resolves Base.esm to no plugin.');
    await expect(recordEditAt(TEXT, at('PatchNpc'))?.edit('Renamed', plugins, () => Promise.resolve(undefined))).rejects.toThrow('mEdit says this file holds no record.');
  });
});
