import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMo2Instance, mo2InstanceContext } from './detectMo2Instance';

describe('isMo2Instance', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-detect-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const layInstance = async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\ngameName=Fallout4\n');
    await mkdir(join(root, 'mods'));
    await mkdir(join(root, 'profiles'));
  };

  it('is true when ModOrganizer.ini, mods/, and profiles/ are all present', async () => {
    await layInstance();
    expect(isMo2Instance(root)).toBe(true);
  });

  it('is false when ModOrganizer.ini is missing', async () => {
    await mkdir(join(root, 'mods'));
    await mkdir(join(root, 'profiles'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false when mods/ is missing', async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\n');
    await mkdir(join(root, 'profiles'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false when profiles/ is missing', async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\n');
    await mkdir(join(root, 'mods'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false for a completely empty folder', () => {
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false for a nonexistent path, without throwing', () => {
    expect(isMo2Instance(join(root, 'does-not-exist'))).toBe(false);
  });

  it('does not read modlist.txt content — a corrupt-but-present instance still reads true (ADR-0026 boundary)', async () => {
    await layInstance();
    await mkdir(join(root, 'profiles', 'Default'));
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '\x00not valid text\xff');
    expect(isMo2Instance(root)).toBe(true);
  });
});


// #554: the welcome's viewsWelcome `when` clause needs a second key
// (modbench.workspaceMo2CheckDone) to tell "checked, and it's not an instance" apart from
// "never checked" — an unset context key reads identically to `false` under a plain `!key`
// negation, so workspaceIsMo2Instance alone can't carry that distinction. This is the one
// place either key's value is decided; every activation exit path (extension.ts) calls it
// instead of setContext directly, so a future path can't set one key without the other.
describe('mo2InstanceContext', () => {
  it('always marks the check done, whether the workspace is an instance or not', () => {
    expect(mo2InstanceContext(true)['modbench.workspaceMo2CheckDone']).toBe(true);
    expect(mo2InstanceContext(false)['modbench.workspaceMo2CheckDone']).toBe(true);
  });

  it('carries the instance verdict through workspaceIsMo2Instance unchanged', () => {
    expect(mo2InstanceContext(true)['modbench.workspaceIsMo2Instance']).toBe(true);
    expect(mo2InstanceContext(false)['modbench.workspaceIsMo2Instance']).toBe(false);
  });
});
