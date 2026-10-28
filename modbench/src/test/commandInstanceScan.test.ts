import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { CORE_BOXES } from '../../eslint-rules/boxes.mjs';
import { productionFiles, SRC } from './scanSource';

const READ_MODEL_NAMES = ['InstanceValue', 'InstanceView'];

const readModelIn = (source: string): string[] =>
  READ_MODEL_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(source));

const commandModules = (): string[] => CORE_BOXES.flatMap((box) => productionFiles(join(SRC, box)));

describe('commands never read the Instance', () => {
  it('covers every command box the core band draws and the code builds', () => {
    expect(CORE_BOXES).toEqual(expect.arrayContaining(['modCommands', 'pluginCommands', 'instanceCommands', 'downloadedFileCommands']));
    expect(commandModules().length).toBeGreaterThan(CORE_BOXES.length);
  });

  it('no command module names the read model', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const found = readModelIn(readFileSync(path, 'utf8'));
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  it('flags a module that names the read model', () => {
    expect(readModelIn("import type { InstanceValue } from '../instanceLoader/instance';\n")).toEqual(['InstanceValue']);
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

  it('flags a module that builds the record index or reads overwrite/ itself', () => {
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

const typeTextOf = (node: ts.PropertySignature | ts.ParameterDeclaration): string | undefined =>
  node.type?.getText().replace(/\s+/g, ' ');

const instanceValueFields = (): ReadonlyMap<string, string> => {
  const path = join(SRC, 'instanceLoader', 'instance.ts');
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const fields = new Map<string, string>();
  file.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'InstanceValue') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.type) fields.set(member.name.getText(), typeTextOf(member) ?? '');
      }
    }
  });
  return fields;
};

const HANDING_ON = new Set(['LoadOrderToDeploy']);

const slicedFieldsIn = (source: string, fields: ReadonlyMap<string, string>): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && HANDING_ON.has(node.name.text)) return;
    if ((ts.isPropertySignature(node) || ts.isParameter(node)) && typeTextOf(node) !== undefined && fields.get(node.name.getText()) === typeTextOf(node)) {
      found.push(node.name.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true));
  return found;
};

describe('no command takes a slice of the instance value', () => {
  it('reads InstanceValue from the loader, so the scan has fields to hold', () => {
    expect([...instanceValueFields().keys()]).toContain('activeProfile');
  });

  it('no command module declares a property or parameter that copies a field of the instance value, by name and type as written', () => {
    const fields = instanceValueFields();
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const found = slicedFieldsIn(readFileSync(path, 'utf8'), fields);
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  it('flags a profile list taken as a parameter, the form switch profile had', () => {
    expect(slicedFieldsIn('function switchProfile(adapter: A, profile: string, profiles: readonly string[]) {}\n', instanceValueFields())).toEqual(['profiles']);
  });

  it('flags a slice declared as a type of its own', () => {
    const planted = 'interface InstanceSlice { readonly profiles: readonly string[]; readonly activeProfile: string; readonly plugins: readonly string[] }\n';
    expect(slicedFieldsIn(planted, instanceValueFields())).toEqual(['profiles', 'activeProfile']);
  });

  it('leaves the load order a command hands on to Deployment alone', () => {
    const planted = 'interface LoadOrderToDeploy { readonly profiles: readonly string[] }\n';
    expect(slicedFieldsIn(planted, instanceValueFields())).toEqual([]);
  });
});
