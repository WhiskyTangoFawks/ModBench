import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { present } from '../ports/present';

// ADR-0015 invariant 2: commands write and forget. One reading the Instance makes the read model
// an input to the write side, and a write's own effect comes back to it twice.

// One directory per command box, as the zoom-out draws the Modbench core band.
const COMMAND_BOXES = ['modlist', 'pluginsCommands', 'instanceCommands', 'install', 'deploy'];

// A type the value carries arrives as an argument, so naming one is not reading the model.
const READ_MODEL_MODULE = join('instance', 'instance');
// `Instance` alone is prose a comment may use; these two are only ever the type.
const READ_MODEL_NAMES = ['InstanceValue', 'InstanceView'];

const readModelIn = (source: string): string[] => [
  ...importsOf(source).filter((spec) => spec.endsWith(READ_MODEL_MODULE)),
  ...READ_MODEL_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(source)),
];

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)].map((m) =>
    present(m[1], 'the matched import-source capture group'),
  );
}

const commandModules = (): string[] =>
  COMMAND_BOXES.flatMap((box) => {
    const dir = join(__dirname, '..', box);
    return readdirSync(dir)
      .filter((name) => extname(name) === '.ts' && !name.endsWith('.test.ts'))
      .map((name) => join(dir, name));
  });

describe('commands never read the Instance', () => {
  it('covers every command box the core band draws', () => {
    expect(COMMAND_BOXES).toEqual(['modlist', 'pluginsCommands', 'instanceCommands', 'install', 'deploy']);
    expect(commandModules().length).toBeGreaterThan(COMMAND_BOXES.length);
  });

  it('no command module imports the read model, directly or by name', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const found = readModelIn(readFileSync(path, 'utf8'));
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  // Rival this catches: a command handed the Instance's value instead of walking disk itself.
  it('flags a module that imports the read model, by module and by name alike', () => {
    expect(readModelIn("import type { InstanceValue } from '../instance/instance';\n"))
      .toEqual([join('..', 'instance', 'instance'), 'InstanceValue']);
  });

  // Rival: a rule so broad that every module of the Instance's box reads as the read model —
  // a command IS handed the winners, as an argument whose type it has to name.
  it('leaves a type the value carries alone, taken from the box beside the read model', () => {
    expect(readModelIn("import type { FileWinners } from '../instance/fileConflictIndex';\n")).toEqual([]);
  });
});

// ADR-0015 invariant 1: the value carries the merged view, so a command is handed the winners
// it needs. One walking mods/ itself doubles the recompute's walk and re-spells overwrite-wins.
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

  // Rival this catches: the plugins reconcile rebuilding the index and re-reading overwrite/
  // instead of taking the value's winners as an argument.
  it('flags a module that builds the index or reads overwrite/ itself', () => {
    const planted = "const index = await buildFileConflictIndex(entries, root, log);\nawait readdir(overwriteDir(root));\n";
    expect(walkersIn(planted)).toEqual(['buildFileConflictIndex', 'overwriteDir']);
  });
});

// The same rule for the rest of a command's inputs: the profiles, the Data folder's plugins and
// the game name are fields of the value, and the caller reads each off it.
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

  // Rival: the profile switch listing `profiles/` itself, and install re-opening
  // ModOrganizer.ini for `gameName`, both of which the value already answers.
  it('flags each probe wherever it is planted', () => {
    expect(probesIn('const all = await listProfiles(root);\n')).toEqual(['listProfiles']);
    expect(probesIn('const gameName = readGameName(await get(settingsFile(instanceRoot)));\n'))
      .toEqual(['readGameName']);
  });
});
