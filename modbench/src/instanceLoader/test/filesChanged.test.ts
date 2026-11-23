import { describe, expect, it } from 'vitest';
import { FileConflictLookup, modOrigin, RUNTIME_OUTPUT, type StackedFile } from '../fileConflictIndex';
import { filesChanged, type FilesChanged } from '../filesChanged';
import type { InstanceValue } from '../instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { fileIn } from '../../test/fakeInstanceAdapter';

const file = (relativePath: string) => fileIn('/mods/Mod', relativePath);

const READS_NAMING_NO_ARCHIVE = { filesByMod: true, foldersByMod: true, overwriteFiles: true, overwriteFolders: true, files: true, stackedCopies: true, mods: true } as const;
const kept = file('a.dds');
const before = instanceValueFixture({ filesByMod: new Map([['Mod', [kept]]]) });
const gained = { ...before, filesByMod: new Map([['Mod', [kept, file('B.dds')]]]) };

describe('what a new value changed of the origins\' files (ADR-0029, Consequences, bullet 5)', () => {
  it.each<[string, InstanceValue | undefined, InstanceValue, FilesChanged]>([
    ['a mod gains a file: that mod, with the file it gained alone', before, gained, [{ origin: modOrigin('Mod'), files: [file('B.dds')], gained: [file('B.dds')] }]],
    ['Overwrite gains a file: Overwrite', before, { ...before, overwriteFiles: [fileIn('/overwrite', 'o.dds')] }, [{ origin: RUNTIME_OUTPUT, files: [fileIn('/overwrite', 'o.dds')], gained: [fileIn('/overwrite', 'o.dds')] }]],
    ['a mod gains a file while an archive starts to load, though the reader names no archive: anything', before, { ...gained, loadsArchive: () => true }, 'every'],
    ['a mod gains a file while a fact the reader reads changes: anything', before, { ...gained, mods: [] }, 'every'],
    ['the stack changes, and no origin\'s files: anything', before, { ...before, stackedCopies: new FileConflictLookup<StackedFile>() }, 'every'],
    ['nothing changes: nothing', before, { ...before }, []],
    ['there is no value before it: anything', undefined, before, 'every'],
  ])('tells, when %s', (_case, was, now, changed) => {
    expect(filesChanged<keyof typeof READS_NAMING_NO_ARCHIVE>(was, now, READS_NAMING_NO_ARCHIVE)).toEqual(changed);
  });
});
