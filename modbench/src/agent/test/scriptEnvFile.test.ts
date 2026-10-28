import { delimiter } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MEditClient } from '../../client';
import { reachMEditFromEnvFile } from '../scriptEnvFile';

const SCRIPTS = '/ext/scripts';
type Status = MEditClient['loadOrderStatus'];

class FakeClient {
  loadOrderStatus: Status;
  private portListeners: ((port: number) => void)[] = [];
  private statusListeners: ((status: Status) => void)[] = [];
  onPort(listener: (port: number) => void) { this.portListeners.push(listener); return () => { this.portListeners = []; }; }
  onLoadOrderStatus(listener: (status: Status) => void) { this.statusListeners.push(listener); return () => { this.statusListeners = []; }; }
  port(port: number) { this.portListeners.forEach((l) => { l(port); }); }
  status(refusal?: { kind: 'heldElsewhere' | 'failed'; message: string }) {
    this.loadOrderStatus = { totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], refusal, version: 1, holdsNone: false };
    this.statusListeners.forEach((l) => { l(this.loadOrderStatus); });
  }
}

const settled = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe('the file the Python tooling reads to reach mEdit', () => {
  let held: string | undefined;
  let failure: Error | undefined;
  let failures: string[];
  const envFile = {
    read: () => Promise.resolve(held ?? ''),
    write: (text: string) => {
      if (failure) return Promise.reject(failure);
      held = text;
      return Promise.resolve();
    },
  };
  const reach = (client: FakeClient, scriptsPath = SCRIPTS) => reachMEditFromEnvFile({
    client, scriptsPath, envFile, fail: (m) => { failures.push(m); },
  });
  const holding = async (port: number, scriptsPath = SCRIPTS) => {
    const client = new FakeClient();
    const window = reach(client, scriptsPath);
    client.status();
    client.port(port);
    await settled();
    return { client, window };
  };
  beforeEach(() => { held = undefined; failure = undefined; failures = []; });

  it('holds PYTHONPATH and MEDIT_PORT once the window holds the record index and the port is known', async () => {
    await holding(41000);

    expect(held).toBe(`PYTHONPATH=${SCRIPTS}\nMEDIT_PORT=41000\n`);
  });

  it('rewrites the port line each time the backend reports its port, and holds one such line', async () => {
    const { client } = await holding(41000);
    client.port(41001);
    await settled();

    expect(held).toBe(`PYTHONPATH=${SCRIPTS}\nMEDIT_PORT=41001\n`);
  });

  it('writes nothing while another window holds the record index', async () => {
    const client = new FakeClient();
    reach(client);
    client.port(41000);
    client.status({ kind: 'heldElsewhere', message: 'other' });
    await settled();

    expect(held).toBeUndefined();
  });

  it('writes nothing before the window knows it holds the record index', async () => {
    const client = new FakeClient();
    reach(client);
    client.port(41000);
    await settled();

    expect(held).toBeUndefined();
  });

  it('writes once the record index is taken over after a refusal', async () => {
    const client = new FakeClient();
    reach(client);
    client.port(41000);
    client.status({ kind: 'heldElsewhere', message: 'other' });
    client.status();
    await settled();

    expect(held).toContain('MEDIT_PORT=41000');
  });

  it('leaves every other line as written, in its own line endings', async () => {
    held = '# mine\r\nA=1\r\nMEDIT_PORT=1\r\n\r\nB="two words"\r\n';
    await holding(41000);

    expect(held).toBe(`# mine\r\nA=1\r\nMEDIT_PORT=41000\r\n\r\nB="two words"\r\nPYTHONPATH=${SCRIPTS}\r\n`);
  });

  it('keeps the entries of a PYTHONPATH line already there, medit\'s folder in front, once however often it writes', async () => {
    held = `PYTHONPATH="/mine${delimiter}/yours"\n`;
    const { client } = await holding(41000);
    client.port(41001);
    await settled();

    expect(held).toBe(`PYTHONPATH=${SCRIPTS}${delimiter}/mine${delimiter}/yours\nMEDIT_PORT=41001\n`);
  });

  it('quotes a PYTHONPATH that holds a space', async () => {
    await holding(41000, '/my ext/scripts');

    expect(held).toContain("PYTHONPATH='/my ext/scripts'");
  });

  it('says why when the file cannot be written', async () => {
    failure = new Error('EACCES');
    await holding(41000);

    expect(failures).toEqual([expect.stringContaining('EACCES')]);
  });

  it('writes nothing once disposed', async () => {
    const { client, window } = await holding(41000);
    window.dispose();
    client.port(41002);
    await settled();

    expect(held).toContain('MEDIT_PORT=41000');
  });
});
