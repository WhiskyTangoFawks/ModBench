import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

// ADR-0047 point 6: commands write and forget. One that read the Instance would make the read
// model an input to the write side, and a write's own effect would come back to it twice.
const READ_MODEL = 'instance';

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)].map((m) => m[1]);
}

const commandModules = (): string[] =>
  readdirSync(__dirname)
    .filter((name) => extname(name) === '.ts' && !name.endsWith('.test.ts'))
    .map((name) => join(__dirname, name));

describe('commands never read the Instance', () => {
  it('covers every command module in this folder', () => {
    expect(commandModules().length).toBeGreaterThan(0);
  });

  it('no command module imports the read model, directly or by name', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const source = readFileSync(path, 'utf8');
      const found = importsOf(source).filter((spec) => spec.toLowerCase().includes(READ_MODEL));
      if (source.includes('InstanceValue')) found.push('InstanceValue');
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  // Rival this catches: a command handed the Instance's value instead of walking disk itself.
  it('flags a module that imports the read model', () => {
    const planted = "import type { InstanceValue } from '../instance';\n";
    expect(importsOf(planted).filter((s) => s.includes(READ_MODEL))).toEqual(['../instance']);
  });
});
