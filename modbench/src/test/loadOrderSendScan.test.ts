// ADR-0013: a landed Instance recompute and a launch are the only things that hand mEdit a load
// order, and the Toolbox — the MO2 side's composition root — is where both are wired.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

// The one legitimate caller: the Toolbox subscribes the Instance to the client's sender at
// activation. No gesture, command or view may reach the sender itself.
const ALLOWED = 'toolbox.ts';

const SEND_CALL = /\.send\s*\(/;

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
    .filter((path) => SEND_CALL.test(readFileSync(path, 'utf8')));
}

describe('only the Toolbox hands the client a load order', () => {
  it('covers the whole extension source tree', () => {
    const root = join(__dirname, '..'); // src/
    expect(tsFiles(root).length).toBeGreaterThan(50);
  });

  it('no file but toolbox.ts calls .send()', () => {
    const root = join(__dirname, '..'); // src/
    expect(findOffenders(root, ALLOWED)).toEqual([]);
  });

  // Rival: a gesture or command module sending a snapshot directly instead of trusting the
  // Instance's watcher to bring the change back — caught by the real walk, not just the regex.
  it('the tree walk itself catches a planted send() call in a non-wiring file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-load-order-send-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const noop = () => undefined;\n");
      await writeFile(
        join(dir, 'nested', 'someCommand.ts'),
        "export const fire = (session) => session.loadOrderSender?.send(snapshot);\n",
      );
      const offenders = findOffenders(dir, join('nowhere', 'no.ts'));
      expect(offenders).toEqual([join(dir, 'nested', 'someCommand.ts')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
