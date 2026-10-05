import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_BOXES } from './boxes';
import { importSpecifiers, productionFiles, SRC } from './scanSource';

const READ_MODEL_MODULE = join('instanceLoader', 'instance');
const READ_MODEL_NAMES = ['InstanceValue', 'InstanceView'];

const readModelIn = (source: string): string[] => [
  ...importSpecifiers(source, 'command.ts').filter((spec) => spec.endsWith(READ_MODEL_MODULE)),
  ...READ_MODEL_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(source)),
];

const commandModules = (): string[] => CORE_BOXES.flatMap((box) => productionFiles(join(SRC, box)));

describe('commands never read the Instance', () => {
  it('covers every command box the core band draws and the code builds', () => {
    expect(CORE_BOXES).toEqual(expect.arrayContaining(['modlist', 'pluginsCommands', 'instanceCommands', 'downloadsCommands', 'install']));
    expect(commandModules().length).toBeGreaterThan(CORE_BOXES.length);
  });

  it('no command module imports the read model, directly or by name', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const found = readModelIn(readFileSync(path, 'utf8'));
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  it('flags a module that imports the read model, by module and by name alike', () => {
    expect(readModelIn("import type { InstanceValue } from '../instanceLoader/instance';\n"))
      .toEqual([join('..', 'instanceLoader', 'instance'), 'InstanceValue']);
  });

  it('leaves a type the value carries alone, taken from the box beside the read model', () => {
    expect(readModelIn("import type { FileWinners } from '../instanceLoader/fileConflictIndex';\n")).toEqual([]);
  });
});

const WALKERS = ['buildFileConflictIndex', 'overwriteDir'];

const walkersIn = (source: string): string[] =>
  WALKERS.filter((name) => new RegExp(`\\b${name}\\b`).test(source));

describe('commands never walk the instance', () => {
  it('no command module builds the file-conflict index or lists overwrite/ itself', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const found = walkersIn(readFileSync(path, 'utf8'));
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  it('flags a module that builds the index or reads overwrite/ itself', () => {
    const planted = "const index = await buildFileConflictIndex(entries, root, log);\nawait readdir(overwriteDir(root));\n";
    expect(walkersIn(planted)).toEqual(['buildFileConflictIndex', 'overwriteDir']);
  });
});

const PROBES = ['listProfiles', 'profilesDir', 'readGameName', 'rootLevelPlugins'];

const probesIn = (source: string): string[] =>
  PROBES.filter((name) => new RegExp(`\\b${name}\\b`).test(source));

describe('a command probes the instance for none of its own inputs', () => {
  it('no command module lists profiles/, walks the Data folder or re-reads the game name', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const found = probesIn(readFileSync(path, 'utf8'));
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  it('flags each probe wherever it is planted', () => {
    expect(probesIn('const all = await listProfiles(root);\n')).toEqual(['listProfiles']);
    expect(probesIn('const gameName = readGameName(await get(settingsFile(instanceRoot)));\n'))
      .toEqual(['readGameName']);
  });
});
