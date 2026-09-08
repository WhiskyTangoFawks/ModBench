// ADR-0044: an Instance recompute and a client connect are the only triggers for a load-order
// PUT. No gesture, command or view may call `request()` on the sync itself.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

// The one legitimate caller: `wireLoadOrderSyncToInstance` in the Instance module, which is the
// wiring ADR-0044 names, not a gesture, command or view.
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

describe('no gesture, command or view requests a load-order sync', () => {
  it('only the Instance wiring calls .request()', () => {
    const root = join(__dirname, '..'); // src/
    const offenders = tsFiles(root)
      .filter((path) => !path.endsWith(ALLOWED))
      .filter((path) => REQUEST_CALL.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  // Rival this catches: a gesture or command module planting a sync request directly instead of
  // trusting the Instance's watcher to bring the change back.
  it('flags a planted request() call in a non-wiring file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-load-order-sync-scan-'));
    try {
      const planted = join(dir, 'someCommand.ts');
      await writeFile(planted, "export const fire = (session) => session.loadOrderSync?.request();\n");
      expect(REQUEST_CALL.test(readFileSync(planted, 'utf8'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
