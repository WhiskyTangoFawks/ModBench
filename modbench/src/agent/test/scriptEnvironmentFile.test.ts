import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import { reachMEditFromEnvFile } from '../scriptEnvironmentFile';

const SCRIPTS = '/ext/scripts';
const heldElsewhere = loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'other' });
const holding = loadOrderStatusEventFixture();

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return address.port;
}

const settled = () => new Promise<void>((done) => { setTimeout(done, 0); });

describe('the file the Python tooling reads to reach mEdit', () => {
  let held: string | undefined;
  let writes: number;
  let failure: Error | undefined;
  let failures: { message: string; detail: string }[];
  const envFile = {
    read: () => Promise.resolve(held ?? ''),
    write: (text: string) => {
      if (failure) return Promise.reject(failure);
      held = text;
      writes += 1;
      return Promise.resolve();
    },
  };
  const reach = (client: InMemoryMEditClient, scriptsPath = SCRIPTS) => reachMEditFromEnvFile({
    client, scriptsPath, envFile, fail: (message, detail) => { failures.push({ message, detail }); },
  });
  const windowHolding = async (port: number, scriptsPath = SCRIPTS) => {
    const client = new InMemoryMEditClient();
    const stop = reach(client, scriptsPath);
    client.emit(holding);
    client.claimedPort(port);
    await settled();
    return { client, stop };
  };
  beforeEach(() => { held = undefined; writes = 0; failure = undefined; failures = []; });

  it('holds PYTHONPATH and MEDIT_PORT once the window holds the record index and the port is known', async () => {
    await windowHolding(41000);

    expect(held).toBe(`PYTHONPATH=${SCRIPTS}\nMEDIT_PORT=41000\n`);
  });

  it('rewrites the port line each time the backend reports its port, and holds one such line', async () => {
    const { client } = await windowHolding(41000);
    client.claimedPort(41001);
    await settled();

    expect(held).toBe(`PYTHONPATH=${SCRIPTS}\nMEDIT_PORT=41001\n`);
  });

  it('writes nothing while another window holds the record index', async () => {
    const client = new InMemoryMEditClient();
    reach(client);
    client.claimedPort(41000);
    client.emit(heldElsewhere);
    await settled();

    expect(held).toBeUndefined();
  });

  it('writes nothing before the window knows it holds the record index', async () => {
    const client = new InMemoryMEditClient();
    reach(client);
    client.claimedPort(41000);
    await settled();

    expect(held).toBeUndefined();
  });

  it('writes once the record index is taken over after a refusal', async () => {
    const client = new InMemoryMEditClient();
    reach(client);
    client.claimedPort(41000);
    client.emit(heldElsewhere);
    client.emit(loadOrderStatusEventFixture({ version: 2 }));
    await settled();

    expect(held).toContain('MEDIT_PORT=41000');
  });

  it('writes nothing again when the bytes would not change', async () => {
    const { client } = await windowHolding(41000);
    client.emit(loadOrderStatusEventFixture({ version: 2 }));
    client.claimedPort(41000);
    await settled();

    expect(writes).toBe(1);
  });

  it.each([
    ['leaves every other line as written, in its own line endings, mixed or not',
      '# mine\r\nA=1\r\nMEDIT_PORT=1\nB="two words"\r\n', `# mine\r\nA=1\r\nMEDIT_PORT=41000\nB="two words"\r\nPYTHONPATH=${SCRIPTS}\r\n`],
    ['rewrites every duplicate of a line it owns, for a later one wins',
      'MEDIT_PORT=1\nMEDIT_PORT=2\n', `MEDIT_PORT=41000\nMEDIT_PORT=41000\nPYTHONPATH=${SCRIPTS}\n`],
    ['keeps export on a line it owns', 'export MEDIT_PORT=1\n', `export MEDIT_PORT=41000\nPYTHONPATH=${SCRIPTS}\n`],
    ['ends a last line that has no line ending before it appends', 'A=1', `A=1\nPYTHONPATH=${SCRIPTS}\nMEDIT_PORT=41000\n`],
    ['keeps the entries of a quoted PYTHONPATH, medit\'s folder in front',
      `PYTHONPATH="/mine${delimiter}/yours"\n`, `PYTHONPATH=${SCRIPTS}${delimiter}/mine${delimiter}/yours\nMEDIT_PORT=41000\n`],
    ['keeps a trailing comment out of the entries and on the line',
      `PYTHONPATH=/a # note\n`, `PYTHONPATH=${SCRIPTS}${delimiter}/a # note\nMEDIT_PORT=41000\n`],
  ])('%s', async (_, before, after) => {
    held = before;
    await windowHolding(41000);

    expect(held).toBe(after);
  });

  it('puts medit\'s folder in front once however often it writes', async () => {
    held = `PYTHONPATH=/mine\n`;
    const { client } = await windowHolding(41000);
    client.claimedPort(41001);
    await settled();

    expect(held).toBe(`PYTHONPATH=${SCRIPTS}${delimiter}/mine\nMEDIT_PORT=41001\n`);
  });

  it('quotes a PYTHONPATH that holds a space', async () => {
    await windowHolding(41000, '/my ext/scripts');

    expect(held).toContain("PYTHONPATH='/my ext/scripts'");
  });

  it('says what failed and why when the file cannot be written', async () => {
    failure = new Error('EACCES');
    await windowHolding(41000);

    expect(failures.map(({ detail }) => detail)).toEqual(['EACCES']);
  });

  it('writes nothing once disposed', async () => {
    const { client, stop } = await windowHolding(41000);
    stop.dispose();
    client.claimedPort(41002);
    await settled();

    expect(held).toContain('MEDIT_PORT=41000');
  });

  describe('a Python process given the variables the file holds', () => {
    it('imports medit and reaches the mEdit on the port the file names', async () => {
      const mEdit = createServer((_, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"rows":[{"answer":42}]}'); });
      await new Promise<void>((listening) => mEdit.listen(0, '127.0.0.1', listening));
      const elsewhere = await mkdtemp(join(tmpdir(), 'script-env-'));
      try {
        const scripts = resolve(__dirname, '../../../../scripts');
        await windowHolding(portOf(mEdit), scripts);
        const variables = Object.fromEntries((held ?? '').split('\n').filter((line) => line.includes('=')).map((line): [string, string] => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

        const { stdout } = await promisify(execFile)(
          process.platform === 'win32' ? 'python' : 'python3',
          ['-c', "import medit; print(medit.select('SELECT 1')[0]['answer'])"],
          { cwd: elsewhere, env: { ...process.env, ...variables } },
        );

        expect(stdout.trim()).toBe('42');
      } finally {
        mEdit.close();
        await rm(elsewhere, { recursive: true, force: true });
      }
    });
  });
});
