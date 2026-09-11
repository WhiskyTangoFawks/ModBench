// ADR-0013: an Instance recompute and a client connect are the only triggers for a load-order
// PUT. No gesture, command or view may call `request()` on the sync itself.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

// The one legitimate caller: `wireLoadOrderSyncToInstance` in the Instance module, which is the
// wiring ADR-0013 names, not a gesture, command or view.
const ALLOWED = join('modmanager', 'instance.ts');

const REQUEST_CALL = /\.request\s*\(/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

// Shared by the production assertion and the rival test below, so a broken walk — a wrong root, a
// silently-excluded directory — fails both the same way, not just the regex.
function findOffenders(root: string, allowed: string): string[] {
  return tsFiles(root)
    .filter((path) => !path.endsWith(allowed))
    .filter((path) => REQUEST_CALL.test(readFileSync(path, 'utf8')));
}

describe('no gesture, command or view requests a load-order sync', () => {
  it('covers the whole extension source tree', () => {
    const root = join(__dirname, '..'); // src/
    expect(tsFiles(root).length).toBeGreaterThan(50);
  });

  it('only the Instance wiring calls .request()', () => {
    const root = join(__dirname, '..'); // src/
    expect(findOffenders(root, ALLOWED)).toEqual([]);
  });

  // Rival: a gesture or command module planting a sync request directly instead of trusting the
  // Instance's watcher to bring the change back — caught by the real walk, not just the regex.
  it('the tree walk itself catches a planted request() call in a non-wiring file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-load-order-sync-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const noop = () => undefined;\n");
      await writeFile(
        join(dir, 'nested', 'someCommand.ts'),
        "export const fire = (session) => session.loadOrderSync?.request();\n",
      );
      const offenders = findOffenders(dir, join('nowhere', 'no.ts'));
      expect(offenders).toEqual([join(dir, 'nested', 'someCommand.ts')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
