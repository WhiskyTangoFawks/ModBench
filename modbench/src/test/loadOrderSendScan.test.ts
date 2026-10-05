import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, resolve } from 'node:path';
import { productionFiles, SRC } from './scanSource';

const SENDS = join('instanceCommands', 'loadOrder.ts');
const PUTS = join('client', 'loadOrderSender.ts');
const PORT = ['MEditClient.ts', 'HttpMEditClient.ts']
  .map((name) => join('client', name));

type CallCheck = (text: string, path: string, root: string) => boolean;

const SEND_CALL: CallCheck = (text) => /\.send\s*\(/.test(text);

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

function findOffenders(root: string, call: CallCheck, allowed: string[]): string[] {
  return productionFiles(root)
    .filter((path) => !allowed.includes(relative(root, path)))
    .filter((path) => call(readFileSync(path, 'utf8'), path, root));
}

describe('only instance commands hand the client a load order', () => {
  it('covers the whole extension source tree', () => {
    expect(productionFiles(SRC).length).toBeGreaterThan(50);
  });

  it('no file but instance commands\' loadOrder.ts calls .send()', () => {
    expect(findOffenders(SRC, SEND_CALL, [SENDS])).toEqual([]);
  });

  it('no file but the sender and the port itself calls putLoadOrder()', () => {
    expect(findOffenders(SRC, PUT_CALL, [PUTS, ...PORT])).toEqual([]);
  });

  it('every allowed path is a file the walk actually reaches', () => {
    const reached = productionFiles(SRC).map((path) => relative(SRC, path));
    expect(reached).toEqual(expect.arrayContaining([SENDS, PUTS, ...PORT]));
  });
});

describe('the walk catches what goes round the sender', () => {
  const SENDER_CALL_SOURCE = "export const fire = (session) => session.loadOrderSender?.send(snapshot);\n";
  const PORT_CALL_SOURCE = "export const fire = (client) => client.putLoadOrder([], '/d', '/i', 'Fallout4');\n";

  it('names a planted send() call in a non-wiring file', async () => {
    await withPlantedFile(join('nested', 'someCommand.ts'), SENDER_CALL_SOURCE, (root, planted) => {
      expect(findOffenders(root, SEND_CALL, ['nowhere.ts'])).toEqual([planted]);
    });
  });

  it('names a planted putLoadOrder() call outside the sender', async () => {
    await withPlantedFile(join('nested', 'someCommand.ts'), PORT_CALL_SOURCE, (root, planted) => {
      expect(findOffenders(root, PUT_CALL, ['nowhere.ts'])).toEqual([planted]);
    });
  });

  it('names a planted bare putLoadOrder() call on a destructured port', async () => {
    const source = "export const fire = (client) => { const { putLoadOrder } = client; return putLoadOrder([], '/d', '/i', 'Fallout4'); };\n";
    await withPlantedFile(join('nested', 'someCommand.ts'), source, (root, planted) => {
      expect(findOffenders(root, PUT_CALL, ['nowhere.ts'])).toEqual([planted]);
    });
  });

  it('leaves a bare call to the imported instance command alone', async () => {
    const source = "import { putLoadOrder } from '../instanceCommands/loadOrder';\nexport const fire = (sender, value) => putLoadOrder(sender, '/i', value);\n";
    await withPlantedFile(join('nested', 'wiring.ts'), source, (root) => {
      expect(findOffenders(root, PUT_CALL, ['nowhere.ts'])).toEqual([]);
    });
  });

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
