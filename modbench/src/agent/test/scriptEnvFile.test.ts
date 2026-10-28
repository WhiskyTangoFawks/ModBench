import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadOrderStatus } from '../../client';
import { reachMEditFromEnvFile } from '../scriptEnvFile';

const SCRIPTS = '/ext/scripts';

class FakeClient {
  loadOrderStatus: LoadOrderStatus | undefined;
  private portListeners: ((port: number) => void)[] = [];
  private statusListeners: ((status: LoadOrderStatus | undefined) => void)[] = [];
  onPort(listener: (port: number) => void) { this.portListeners.push(listener); return () => { this.portListeners = []; }; }
  onLoadOrderStatus(listener: (status: LoadOrderStatus | undefined) => void) { this.statusListeners.push(listener); return () => { this.statusListeners = []; }; }
  port(port: number) { this.portListeners.forEach((l) => { l(port); }); }
  status(refusal?: LoadOrderStatus['refusal']) {
    this.loadOrderStatus = { refusal } as LoadOrderStatus;
    this.statusListeners.forEach((l) => { l(this.loadOrderStatus); });
  }
}

describe('the file the Python tooling reads to reach mEdit', () => {
  let root: string;
  let envFileSetting: string | undefined;
  let failures: string[];
  const envFile = () => join(root, '.env');
  const reach = (client: FakeClient, scriptsPath = SCRIPTS) => reachMEditFromEnvFile({
    client, scriptsPath, instanceRoot: root, envFileSetting: () => envFileSetting, fail: (m) => { failures.push(m); },
  });
  const text = () => readFileSync(envFile(), 'utf8');
  const holding = (port: number, scriptsPath = SCRIPTS) => {
    const client = new FakeClient();
    const window = reach(client, scriptsPath);
    client.status();
    client.port(port);
    return { client, window };
  };

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'envfile-')); envFileSetting = undefined; failures = []; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('holds PYTHONPATH and MEDIT_PORT in .env at the instance root once the window holds the record index and the port is known', () => {
    holding(41000);

    expect(text()).toBe(`PYTHONPATH=${SCRIPTS}\nMEDIT_PORT=41000\n`);
  });

  it('rewrites the port line each time the backend reports its port, and holds one such line', () => {
    const { client } = holding(41000);
    client.port(41001);

    expect(text()).toBe(`PYTHONPATH=${SCRIPTS}\nMEDIT_PORT=41001\n`);
  });

  it('writes nothing while another window holds the record index', () => {
    const client = new FakeClient();
    reach(client);
    client.port(41000);
    client.status({ kind: 'heldElsewhere', message: 'other' });

    expect(existsSync(envFile())).toBe(false);
  });

  it('writes nothing before the window knows it holds the record index', () => {
    const client = new FakeClient();
    reach(client);
    client.port(41000);

    expect(existsSync(envFile())).toBe(false);
  });

  it('writes once the record index is taken over after a refusal', () => {
    const client = new FakeClient();
    reach(client);
    client.port(41000);
    client.status({ kind: 'heldElsewhere', message: 'other' });
    client.status();

    expect(text()).toContain('MEDIT_PORT=41000');
  });

  it('leaves every other line as written, in its own line endings', () => {
    writeFileSync(envFile(), '# mine\r\nA=1\r\nMEDIT_PORT=1\r\n\r\nB="two words"\r\n');
    holding(41000);

    expect(text()).toBe(`# mine\r\nA=1\r\nMEDIT_PORT=41000\r\n\r\nB="two words"\r\nPYTHONPATH=${SCRIPTS}\r\n`);
  });

  it('keeps the entries of a PYTHONPATH line already there, medit\'s folder in front, once however often it writes', () => {
    writeFileSync(envFile(), `PYTHONPATH="/mine${delimiter}/yours"\n`);
    const { client } = holding(41000);
    client.port(41001);

    expect(text()).toBe(`PYTHONPATH=${SCRIPTS}${delimiter}/mine${delimiter}/yours\nMEDIT_PORT=41001\n`);
  });

  it('quotes a PYTHONPATH that holds a space', () => {
    holding(41000, '/my ext/scripts');

    expect(text()).toContain("PYTHONPATH='/my ext/scripts'");
  });

  it.each([
    ['a path under ${workspaceFolder}', '${workspaceFolder}/config/py.env', 'config/py.env'],
    ['a path relative to the instance', 'config/py.env', 'config/py.env'],
  ])('writes the file python.envFile names: %s', (_, setting, expected) => {
    envFileSetting = setting;
    mkdirSync(join(root, 'config'));
    holding(41000);

    expect(existsSync(join(root, expected))).toBe(true);
    expect(existsSync(envFile())).toBe(false);
  });

  it('says why when the file cannot be written', () => {
    envFileSetting = '${workspaceFolder}/missing/dir/.env';
    holding(41000);

    expect(failures).toHaveLength(1);
  });

  it('writes nothing once disposed', () => {
    const { client, window } = holding(41000);
    window.dispose();
    client.port(41002);

    expect(text()).toContain('MEDIT_PORT=41000');
  });
});
