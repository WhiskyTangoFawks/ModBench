// ADR-0013: a landed Instance recompute and a launch are the only things that hand mEdit a load
// order, and the client's sender is the only thing that reaches the port verb underneath.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, relative, dirname } from 'node:path';

// The Toolbox subscribes the Instance to the sender at activation; no gesture, command or view
// may reach the sender itself.
const SENDS = 'toolbox.ts';
// The sender owns connect-before-the-first-PUT, one PUT at a time and supersession, so a second
// caller of the port verb would be a second implementation of the arrow.
const PUTS = join('medit', 'client', 'loadOrderSender.ts');
// The port declares the verb and its two adapters implement it; what the scan forbids is a
// *third* party calling it.
const PORT = ['MEditClient.ts', 'HttpMEditClient.ts', 'InMemoryMEditClient.ts']
  .map((name) => join('medit', 'client', name));

const SEND_CALL = /\.send\s*\(/;
const PUT_CALL = /\bputLoadOrder\s*\(/;

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

// Shared by the production assertions and the rivals below, so a broken walk fails them the same
// way. The allowed files are whole relative paths: `endsWith` would exempt a `subtoolbox.ts` too.
function findOffenders(root: string, call: RegExp, allowed: string[]): string[] {
  return tsFiles(root)
    .filter((path) => !allowed.includes(relative(root, path)))
    .filter((path) => call.test(readFileSync(path, 'utf8')));
}

const SRC = join(__dirname, '..');

describe('only the Toolbox hands the client a load order', () => {
  it('covers the whole extension source tree', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(50);
  });

  it('no file but toolbox.ts calls .send()', () => {
    expect(findOffenders(SRC, SEND_CALL, [SENDS])).toEqual([]);
  });

  it('no file but the sender and the port itself calls putLoadOrder()', () => {
    expect(findOffenders(SRC, PUT_CALL, [PUTS, ...PORT])).toEqual([]);
  });

  // The allowlist must name files that are really there, or an allowed path silently becomes a
  // rule about nothing.
  it('every allowed path is a file the walk actually reaches', () => {
    const reached = tsFiles(SRC).map((path) => relative(SRC, path));
    expect(reached).toEqual(expect.arrayContaining([SENDS, PUTS, ...PORT]));
  });
});

// Each rival runs through the one shared findOffenders(), over a real temporary tree rather than
// a hand-built string, so the walk itself is on test and not just the regex.
describe('the walk catches what goes round the sender', () => {
  const SENDER_CALL_SOURCE = "export const fire = (session) => session.loadOrderSender?.send(snapshot);\n";
  const PORT_CALL_SOURCE = "export const fire = (client) => client.putLoadOrder([], '/d', '/i', 'Fallout4');\n";

  // Rival: a gesture or command module sending a snapshot directly instead of trusting the
  // Instance's watcher to bring the change back.
  it('names a planted send() call in a non-wiring file', async () => {
    await withPlantedFile(join('nested', 'someCommand.ts'), SENDER_CALL_SOURCE, (root, planted) => {
      expect(findOffenders(root, SEND_CALL, ['nowhere.ts'])).toEqual([planted]);
    });
  });

  // Rival: a caller going round the sender straight to the port, which would put a second
  // sequencing story on the arrow.
  it('names a planted putLoadOrder() call outside the sender', async () => {
    await withPlantedFile(join('nested', 'someCommand.ts'), PORT_CALL_SOURCE, (root, planted) => {
      expect(findOffenders(root, PUT_CALL, ['nowhere.ts'])).toEqual([planted]);
    });
  });

  // Rival: the allowlist matched loosely. A file whose name merely ends with an allowed one is a
  // different file and stays an offender.
  it('does not exempt a file whose name merely ends with an allowed one', async () => {
    await withPlantedFile('subtoolbox.ts', SENDER_CALL_SOURCE, (root, planted) => {
      expect(findOffenders(root, SEND_CALL, [SENDS])).toEqual([planted]);
    });
  });
});

async function withPlantedFile(
  relativePath: string, source: string, check: (root: string, planted: string) => void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'medit-load-order-send-scan-'));
  try {
    await mkdir(dirname(join(dir, relativePath)), { recursive: true });
    await writeFile(join(dir, 'topLevel.ts'), "export const noop = () => undefined;\n");
    await writeFile(join(dir, relativePath), source);
    check(dir, join(dir, relativePath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
