import { afterEach, describe, expect, it, vi } from 'vitest';

type Held = [{ scheme: string; fsPath: string }, { severity: number; range: { start: { line: number } }; message: string }[]][];
const diagnosticsHeld = vi.hoisted(() => ({ held: [] as Held }));
vi.mock('vscode', () => ({
  languages: { getDiagnostics: () => diagnosticsHeld.held },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3, 0: 'Error', 1: 'Warning', 2: 'Information', 3: 'Hint' },
}));
import { createServer, request, type OutgoingHttpHeaders, type Server } from 'node:http';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveAgent, type AgentServer } from '../agentServer';
import { FileConflictLookup, modOrigin, RUNTIME_OUTPUT, type ConflictEntry } from '../../instanceLoader/fileConflictIndex';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { SILENT_LOG } from '../../ports/log';
import { present } from '../../ports/present';

const PORT_SETTING = 'modbench.agent.port';

const VALUE = instanceValueFixture({
  profiles: ['Default', 'Survival'],
  activeProfile: 'Survival',
  mods: [
    { kind: 'separator', name: 'Textures', enabled: true },
    { kind: 'mod', name: 'Big Rocks', enabled: false },
  ],
  plugins: [
    { name: 'B.esp', path: '/m/B.esp', origin: 'Big Rocks', line: 1, enabled: false, winning: true },
    { name: 'A.esp', path: '/m/A.esp', origin: 'Big Rocks', line: 0, enabled: true, winning: true },
  ],
  downloads: { kind: 'listed', rows: [{
    name: 'rocks.7z', displayName: 'Rocks', status: 'Installed', size: 5, mtimeMs: 0, hasMeta: true, excluded: false,
    upgrades: [], path: '/d/rocks.7z', sidecarPath: '/d/rocks.7z.meta',
  }] },
});

const running: AgentServer[] = [];
const blockers: Server[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  running.splice(0).forEach((server) => { server.dispose(); });
  await Promise.all(blockers.splice(0).map((blocker) => new Promise((done) => blocker.close(done))));
});

async function serve(instance: FakeInstance | undefined, port = 0, mEdit?: InMemoryMEditClient) {
  const reporter = recordingReporter();
  const lines: string[] = [];
  const server = serveAgent({
    port, instance, mEdit, reporter, log: { ...SILENT_LOG, info: (line) => lines.push(line), warn: (line) => lines.push(line) },
  });
  running.push(server);
  const address = await server.listening;
  return { reporter, lines, address, bound: address?.port };
}

async function clientOf(instance: FakeInstance | undefined, mEdit?: InMemoryMEditClient): Promise<Client> {
  const { bound } = await serve(instance, 0, mEdit);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${present(bound, 'a bound port')}/mcp`)));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const block = present(result.content[0], 'a content block');
  if (block.type !== 'text') throw new Error(`Expected text, got ${block.type}`);
  return { isError: result.isError === true, text: block.text };
}

async function read(client: Client, name: string, args?: Record<string, unknown>): Promise<unknown> {
  return JSON.parse((await call(client, name, args)).text);
}

describe('the agent server, given an instance value', () => {
  it('lists each read as a tool', async () => {
    const client = await clientOf(new FakeInstance(VALUE));

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_downloads', 'list_file_conflicts', 'list_mods', 'list_plugins', 'list_profiles', 'list_source_problems', 'resolve_names']);
  });

  it('reads the profiles and the active one', async () => {
    const client = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_profiles')).toEqual({ active: 'Survival', profiles: ['Default', 'Survival'] });
  });

  it('reads the mod order with each entry enabled or not', async () => {
    const client = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_mods')).toEqual([
      { kind: 'separator', name: 'Textures', enabled: true },
      { kind: 'mod', name: 'Big Rocks', enabled: false },
    ]);
  });

  it('reads the plugin order by line, each plugin with its origin and whether it is enabled', async () => {
    const client = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_plugins')).toEqual([
      { name: 'A.esp', origin: 'Big Rocks', line: 0, enabled: true, winning: true },
      { name: 'B.esp', origin: 'Big Rocks', line: 1, enabled: false, winning: true },
    ]);
  });

  it('reads the downloaded files by file name', async () => {
    const client = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_downloads')).toEqual([{ name: 'rocks.7z', status: 'Installed', excluded: false }]);
  });

  it('reads the problems on plugin source files only, as the Problems panel holds them', async () => {
    const client = await clientOf(new FakeInstance(VALUE));
    const problem = (severity: number, line: number, message: string) => ({ severity, range: { start: { line } }, message });
    diagnosticsHeld.held = [
      [{ scheme: 'file', fsPath: '/i/source/Rocks/plugin-source/Rocks.esp.json' }, [problem(0, 4, 'bad reference'), problem(1, 9, 'odd value')]],
      [{ scheme: 'file', fsPath: '/i/mods/Rocks/readme.json' }, [problem(0, 0, 'not source')]],
      [{ scheme: 'untitled', fsPath: '/i/source/Rocks/plugin-source/Other.esp.json' }, [problem(0, 0, 'not a file')]],
    ];

    expect(await read(client, 'list_source_problems')).toEqual([
      { file: '/i/source/Rocks/plugin-source/Rocks.esp.json', severity: 'Error', line: 5, message: 'bad reference' },
      { file: '/i/source/Rocks/plugin-source/Rocks.esp.json', severity: 'Warning', line: 10, message: 'odd value' },
    ]);
  });

  it('reads the value as it stands on each request', async () => {
    const instance = new FakeInstance(VALUE);
    const client = await clientOf(instance);
    instance.publish(instanceValueFixture({ activeProfile: 'Default', profiles: ['Default'] }));

    expect(await read(client, 'list_profiles')).toEqual({ active: 'Default', profiles: ['Default'] });
  });

  it('refuses a read whose downloads folder is unresolved with the reason, in the Output and in no notification', async () => {
    const instance = new FakeInstance(instanceValueFixture({ downloads: { kind: 'unresolved', reason: 'no downloads folder' } }));
    const { bound, lines, reporter } = await serve(instance);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${present(bound, 'a bound port')}/mcp`)));
    clients.push(client);

    expect(await call(client, 'list_downloads')).toEqual({ isError: true, text: 'no downloads folder' });
    expect(lines.join('\n')).toContain('no downloads folder');
    expect(reporter.reports).toEqual([]);
  });

  it('refuses a read before the instance has been read', async () => {
    const client = await clientOf(new FakeInstance(VALUE, 0));

    const refusal = await call(client, 'list_profiles');
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain('not been read');
  });
});

const providing = (relativePath: string, ...providers: ConflictEntry['providers']): ConflictEntry =>
  ({ relativePath, winner: `/m/${relativePath}`, winnerOrigin: providers[0] ?? RUNTIME_OUTPUT, providers });
const [A, B, C] = ['A', 'B', 'C'].map(modOrigin);
const asLookup = (...entries: ConflictEntry[]) => {
  const files = new FileConflictLookup();
  entries.forEach((entry) => { files.set(entry); });
  return files;
};
const CONFLICTED = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'A', enabled: true },
    { kind: 'separator', name: 'Textures', enabled: true },
    { kind: 'mod', name: 'Textures', enabled: true },
    { kind: 'mod', name: 'B', enabled: true },
    { kind: 'mod', name: 'C', enabled: true },
  ],
  files: asLookup(
    providing('textures/rock.dds', A, B),
    providing('meshes/x.nif', B, C),
    providing('f.esp', RUNTIME_OUTPUT, C),
    providing('readme.txt', C),
  ),
});

describe('the agent server, reading file order conflicts', () => {
  it('reads, for each mod, the files it wins over which mods and the files it loses to which winner', async () => {
    const client = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] })).toEqual([
      { mod: 'A', wins: [{ file: 'textures/rock.dds', over: ['B'] }], loses: [] },
      { mod: 'B', wins: [{ file: 'meshes/x.nif', over: ['C'] }], loses: [{ file: 'textures/rock.dds', winner: 'A' }] },
      { mod: 'C', wins: [], loses: [{ file: 'f.esp', winner: 'Overwrite' }, { file: 'meshes/x.nif', winner: 'B' }] },
    ]);
  });

  it('reads every mod, and no separator, when it is given no mods', async () => {
    const client = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts')).toMatchObject([{ mod: 'A' }, { mod: 'Textures' }, { mod: 'B' }, { mod: 'C' }]);
  });

  it('names a mod apart from a separator of the same name by which of the two it is', async () => {
    const client = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'Textures', kind: 'mod' }] })).toEqual([{ mod: 'Textures', wins: [], loses: [] }]);
    const separator = await call(client, 'list_file_conflicts', { mods: [{ name: 'Textures', kind: 'separator' }] });
    expect(separator.isError).toBe(true);
    expect(separator.text).toContain('separator');
  });

  it('refuses a name that means a mod and a separator, listing each as the agent can name it, and picks neither', async () => {
    const client = await clientOf(new FakeInstance(CONFLICTED));

    const refusal = await call(client, 'list_file_conflicts', { mods: [{ name: 'A' }, { name: 'Textures' }] });

    expect(refusal).toEqual({
      isError: true,
      text: '"Textures" means more than one thing: separator Textures; mod Textures. Name it with its kind.',
    });
  });

  it('refuses every name that cannot be resolved in one answer, so several names are named as a selection is', async () => {
    const client = await clientOf(new FakeInstance(CONFLICTED));

    const refusal = await call(client, 'list_file_conflicts', { mods: [{ name: 'Nope' }, { name: 'Textures' }, { name: 'A' }] });

    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain('Nothing is named "Nope".');
    expect(refusal.text).toContain('"Textures" means more than one thing');
  });
});

describe('the agent server, resolving names through mEdit', () => {
  const shared = { name: 'Shared.esp', origin: 'ModA' };

  it('hands mEdit the names, with their origins, and answers what each means', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', [{ plugin: shared }, { formKey: '000800:Shared.esp', editorId: 'SharedNpc' }]);
    const client = await clientOf(new FakeInstance(VALUE), mEdit);

    const named = await read(client, 'resolve_names', { names: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }] });

    expect(mEdit.calls).toContainEqual({ method: 'resolveNames', args: [[{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }]] });
    expect(named).toEqual([{ plugin: shared }, { formKey: '000800:Shared.esp', editorId: 'SharedNpc' }]);
  });

  it('refuses with mEdit\'s own listing of the matches, copying none of it', async () => {
    const mEdit = new InMemoryMEditClient();
    const listing = '"Shared.esp" means more than one thing: plugin Shared.esp (origin ModA); plugin Shared.esp (origin ModB).';
    mEdit.setQueryAnswer('resolveNames', { failed: 'refused', refusal: listing });
    const client = await clientOf(new FakeInstance(VALUE), mEdit);

    expect(await call(client, 'resolve_names', { names: [{ name: 'Shared.esp' }] })).toEqual({ isError: true, text: listing });
  });

  it('refuses when mEdit is not available to the agent', async () => {
    const client = await clientOf(new FakeInstance(VALUE));

    const refusal = await call(client, 'resolve_names', { names: [{ name: 'Shared.esp' }] });

    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain('mEdit');
  });
});

describe('the agent server, given no instance', () => {
  it('refuses each request, saying so', async () => {
    const client = await clientOf(undefined);

    for (const name of ['list_profiles', 'list_mods', 'list_plugins', 'list_downloads']) {
      const refusal = await call(client, name);
      expect(refusal.isError).toBe(true);
      expect(refusal.text).toContain('no Modbench instance');
    }
  });
});

describe('the agent server, given a port', () => {
  it('binds the loopback address alone', async () => {
    const { address } = await serve(new FakeInstance(VALUE));

    expect(address?.address).toBe('127.0.0.1');
  });

  const post = (port: number, headers: OutgoingHttpHeaders, body: string) => new Promise<number | undefined>((done) => {
    const sent = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (response) => { response.resume(); done(response.statusCode); });
    sent.end(body);
  });
  const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  it('refuses a request whose Host is another name, so a rebound name cannot reach it', async () => {
    const { bound } = await serve(new FakeInstance(VALUE));

    expect(await post(present(bound, 'a bound port'), { ...JSON_HEADERS, host: 'rebound.example' }, '{}')).toBe(403);
  });

  it('refuses a request from a web page, which carries an Origin', async () => {
    const { bound } = await serve(new FakeInstance(VALUE));

    expect(await post(present(bound, 'a bound port'), { ...JSON_HEADERS, origin: 'https://rebound.example' }, '{}')).toBe(403);
  });

  it('answers a body that is not JSON with 400', async () => {
    const { bound } = await serve(new FakeInstance(VALUE));

    expect(await post(present(bound, 'a bound port'), JSON_HEADERS, '{not json')).toBe(400);
  });

  it('reports through the reporter, naming the setting and the port, when the port is taken', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    const taken = await new Promise<number>((done) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        done(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    const { bound, reporter } = await serve(new FakeInstance(VALUE), taken);

    expect(bound).toBeUndefined();
    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0]?.severity).toBe('error');
    expect(reporter.reports[0]?.message).toContain(PORT_SETTING);
    expect(reporter.reports[0]?.message).toContain(String(taken));
  });
});
