// ADR-0013: a landed Instance recompute and a launch are the only things that hand mEdit a load
// order, and the client's sender is the only thing that reaches the port verb underneath.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, resolve } from 'node:path';
import { tsFiles } from './tsFiles';

// Instance commands' put load order is the one caller of the sender; the root subscribes it to the
// Instance loader's value, and no gesture, other command or view may reach the sender itself.
const SENDS = join('instanceCommands', 'loadOrder.ts');
// The sender owns connect-before-the-first-PUT, one PUT at a time and supersession, so a second
// caller of the port verb would be a second implementation of the arrow.
const PUTS = join('client', 'loadOrderSender.ts');
// The port declares the verb and its two adapters implement it; what the scan forbids is a
// *third* party calling it.
const PORT = ['MEditClient.ts', 'HttpMEditClient.ts', 'InMemoryMEditClient.ts']
  .map((name) => join('client', name));

type CallCheck = (text: string, path: string, root: string) => boolean;

const SEND_CALL: CallCheck = (text) => /\.send\s*\(/.test(text);

// Instance commands' own `putLoadOrder` is the command the sender serves. A bare call is bound to
// it in its own module or through an import of that module; any other bare call is the port verb.
const COMMAND_MODULE = join('instanceCommands', 'loadOrder');
const MEMBER_PUT = /\.putLoadOrder\s*\(/;
const BARE_PUT = /(?<![.\w$])putLoadOrder\s*\(/;
const COMMAND_IMPORTS = /import\s*\{[^}]*\bputLoadOrder\b[^}]*\}\s*from\s*'([^']+)'/g;

function bindsTheCommand(text: string, path: string, root: string): boolean {
  if (relative(root, path) === `${COMMAND_MODULE}.ts`) return true;
  return [...text.matchAll(COMMAND_IMPORTS)]
    .some((m) => resolve(dirname(path), m[1] ?? '') === join(root, COMMAND_MODULE));
}

const PUT_CALL: CallCheck = (text, path, root) =>
  MEMBER_PUT.test(text) || (BARE_PUT.test(text) && !bindsTheCommand(text, path, root));

const PRODUCTION_FILES: Parameters<typeof tsFiles>[1] = { exclude: ['generated'], tsx: false, includeTests: false };

// Shared by the production assertions and the rivals below, so a broken walk fails them the same
// way. The allowed files are whole relative paths: `endsWith` would exempt a `subloadOrder.ts` too.
function findOffenders(root: string, call: CallCheck, allowed: string[]): string[] {
  return tsFiles(root, PRODUCTION_FILES)
    .filter((path) => !allowed.includes(relative(root, path)))
    .filter((path) => call(readFileSync(path, 'utf8'), path, root));
}

const SRC = join(__dirname, '..');

describe('only instance commands hand the client a load order', () => {
  it('covers the whole extension source tree', () => {
    expect(tsFiles(SRC, PRODUCTION_FILES).length).toBeGreaterThan(50);
  });

  it('no file but instance commands\' loadOrder.ts calls .send()', () => {
    expect(findOffenders(SRC, SEND_CALL, [SENDS])).toEqual([]);
  });

  it('no file but the sender and the port itself calls putLoadOrder()', () => {
    expect(findOffenders(SRC, PUT_CALL, [PUTS, ...PORT])).toEqual([]);
  });

  // The allowlist must name files that are really there, or an allowed path silently becomes a
  // rule about nothing.
  it('every allowed path is a file the walk actually reaches', () => {
    const reached = tsFiles(SRC, PRODUCTION_FILES).map((path) => relative(SRC, path));
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

  // Rival: the port verb taken off the client by destructuring, then called bare.
  it('names a planted bare putLoadOrder() call on a destructured port', async () => {
    const source = "export const fire = (client) => { const { putLoadOrder } = client; return putLoadOrder([], '/d', '/i', 'Fallout4'); };\n";
    await withPlantedFile(join('nested', 'someCommand.ts'), source, (root, planted) => {
      expect(findOffenders(root, PUT_CALL, ['nowhere.ts'])).toEqual([planted]);
    });
  });

  // Rival: every bare call flagged, which would name the root for calling the instance command.
  it('leaves a bare call to the imported instance command alone', async () => {
    const source = "import { putLoadOrder } from '../instanceCommands/loadOrder';\nexport const fire = (sender, value) => putLoadOrder(sender, '/i', value);\n";
    await withPlantedFile(join('nested', 'wiring.ts'), source, (root) => {
      expect(findOffenders(root, PUT_CALL, ['nowhere.ts'])).toEqual([]);
    });
  });

  // Rival: the allowlist matched loosely. A file whose name merely ends with an allowed one is a
  // different file and stays an offender.
  it('does not exempt a file whose name merely ends with an allowed one', async () => {
    await withPlantedFile(join('instanceCommands', 'subloadOrder.ts'), SENDER_CALL_SOURCE, (root, planted) => {
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
