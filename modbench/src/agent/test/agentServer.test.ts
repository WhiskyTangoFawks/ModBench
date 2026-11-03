import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Held = [{ scheme: string; fsPath: string }, { severity: number; range: { start: { line: number } }; message: string; source?: string; code?: unknown }[]][];
const diagnosticsHeld = vi.hoisted(() => ({ held: [] as Held }));
const fired = vi.hoisted((): { calls: unknown[][]; outcome: unknown; failure: Error | undefined } => ({ calls: [], outcome: undefined, failure: undefined }));
vi.mock('vscode', () => ({
  languages: { getDiagnostics: () => diagnosticsHeld.held },
  commands: { executeCommand: (...args: unknown[]) => { fired.calls.push(args); return fired.failure ? Promise.reject(fired.failure) : Promise.resolve(fired.outcome); } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3, 0: 'Error', 1: 'Warning', 2: 'Information', 3: 'Hint' },
}));
import { createServer, request, type OutgoingHttpHeaders, type Server } from 'node:http';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TerminalEnvironment } from '../scriptEnvironment';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { serveAgent, type AgentServer, type AgentServerOptions } from '../agentServer';
import type { Argument } from '../../wire/argument';
import type { InstanceValue } from '../../instanceLoader/instance';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { FileConflictLookup, modOrigin, RUNTIME_OUTPUT, type ConflictEntry } from '../../instanceLoader/fileConflictIndex';
import type { MEditClient } from '../../client/MEditClient';
import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { status } from '../../test/modStatusFixture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { comparisonOf } from '../../test/comparison';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { fakeInstanceAdapter, fileIn, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { SILENT_LOG } from '../../ports/log';
import { present } from '../../ports/present';
import { DATA_DIRECTORY_ORIGIN, exactPluginAddressKey, type PluginAddress } from '../../wire/pluginAddress';
import type { PluginShown, PluginsShown } from '../../drivingLib/pluginsShown';

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
  downloadedFiles: { kind: 'listed', rows: [{
    name: 'rocks.7z', displayName: 'Rocks', status: 'Installed', size: 5, mtimeMs: 7, hasMeta: true, excluded: false,
    modID: '12', fileID: '34', version: '1.2', modName: 'Big Rocks', gameName: 'fallout4', author: 'Ann',
    upgrades: [{ modName: 'Big Rocks', version: '1.0', tier: 'fileId' }, { modName: 'Other Rocks' }], path: '/d/rocks.7z', metadataPath: '/d/rocks.7z.meta',
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

const NO_ENVIRONMENT = { forEach: () => undefined };
const NO_TOOLBOX = {
  game: { name: 'Fallout 4', folder: GAME_FOLDER_NOT_FOUND, versions: { kind: 'unresolved' } },
  gameFolderLinks: 0, holdsRepository: false, deployment: { folder: null },
};
const NO_STANDING = { mEdit: () => [], plugins: () => [], sortingRules: () => [], modList: () => [], sourceLanguage: () => [] };
const NO_DEPLOYMENT = { folder: () => undefined, pluginsTxtPlace: () => Promise.resolve({ why: 'none' }) };

const statusRead: { asked: number; answer: readonly ModStatus[] } = { asked: 0, answer: [] };
const statuses = { current: () => { statusRead.asked += 1; return Promise.resolve(new Map(statusRead.answer.map((held) => [held.mod, held]))); } };

const NOT_READ: PluginShown = { statuses: [], readOnly: null, compiled: null, masters: null };
const shownRead: { answer: ReadonlyMap<string, PluginShown> } = { answer: new Map() };
const sortingRead: { rules: ReturnType<PluginsShown['brokenRules']>[number][]; moves: ReturnType<PluginsShown['suggestedMoves']>[number][]; notJudged?: string } = { rules: [], moves: [] };
const pluginsShown = {
  shown: (plugin: PluginAddress) => shownRead.answer.get(exactPluginAddressKey(plugin)) ?? NOT_READ,
  sortingNotJudged: () => sortingRead.notJudged,
  brokenRules: () => sortingRead.rules,
  suggestedMoves: () => sortingRead.moves,
};
afterEach(() => { shownRead.answer = new Map(); sortingRead.rules = []; sortingRead.moves = []; sortingRead.notJudged = undefined; });

const copyAnswers: InstanceAnswers = {};

async function serve(instance: FakeInstance | undefined, port = 0, mEdit = new InMemoryMEditClient(), terminalEnvironment: TerminalEnvironment = NO_ENVIRONMENT, deployment: AgentServerOptions['deployment'] = NO_DEPLOYMENT, standing: AgentServerOptions['standing'] = NO_STANDING) {
  const reporter = recordingReporter();
  const lines: string[] = [];
  const warned: string[] = [];
  const errored: string[] = [];
  const server = serveAgent({
    port, instance, copyReads: fakeInstanceAdapter(readingFixture(), copyAnswers).adapter, mEdit, terminalEnvironment, reporter, statuses, deployment, standing, pluginsShown,
    log: { ...SILENT_LOG, info: (line) => lines.push(line), warn: (line) => { lines.push(line); warned.push(line); }, error: (line) => { lines.push(line); errored.push(line); } },
  });
  running.push(server);
  const address = await server.listening;
  return { reporter, lines, warned, errored, address, bound: address?.port };
}

async function clientOf(instance: FakeInstance | undefined, mEdit = new InMemoryMEditClient(), terminalEnvironment?: TerminalEnvironment, deployment: AgentServerOptions['deployment'] = NO_DEPLOYMENT, standing: AgentServerOptions['standing'] = NO_STANDING) {
  const { bound, ...heard } = await serve(instance, 0, mEdit, terminalEnvironment, deployment, standing);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${present(bound, 'a bound port')}/mcp`)));
  clients.push(client);
  return { client, ...heard };
}

async function takenPort(): Promise<number> {
  const blocker = createServer();
  blockers.push(blocker);
  return new Promise<number>((done) => {
    blocker.listen(0, '127.0.0.1', () => {
      const address = blocker.address();
      done(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
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
    const { client } = await clientOf(new FakeInstance(VALUE));

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_downloads', 'list_file_conflicts', 'list_mod_statuses', 'list_mods', 'list_plugins', 'list_profiles', 'list_problems', 'list_sorting_rules', 'list_references', 'read_record', 'resolve_instance_names', 'resolve_names', 'script_environment', 'select_rows']));
  });

  it('advertises the JSON type of every input of every tool, so a client sends JSON and never a string', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));

    const { tools } = await client.listTools();

    const untyped = tools.flatMap(({ name, inputSchema }) => Object.entries(inputSchema.properties ?? {})
      .filter(([, property]) => !('type' in property))
      .map(([input]) => `${name}.${input}`));
    expect(tools.map((tool) => tool.name)).toContain('plugin_move');
    expect(untyped).toEqual([]);
  });

  it('hands the client its instructions on initialize', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));

    expect(client.getInstructions()).toContain('select_rows says which');
  });

  it('hands a shell the variables the terminals of its window hold, as they are now', async () => {
    const held = new Map([['MEDIT_PORT', { value: '5172' }], ['PYTHONPATH', { value: '/ext/scripts' }]]);
    const { client } = await clientOf(new FakeInstance(VALUE), undefined, { forEach: (each) => { held.forEach((mutator, name) => { each(name, mutator); }); } });
    held.set('MEDIT_PORT', { value: '6001' });

    expect(await read(client, 'script_environment')).toEqual({ MEDIT_PORT: '6001', PYTHONPATH: '/ext/scripts' });
  });

  it('reads the profiles and the active one', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_profiles')).toEqual({ ...NO_TOOLBOX, active: 'Survival', profiles: ['Default', 'Survival'] });
  });

  it('reads the Toolbox: the game and where it was looked for, its versions, the links, the repository, the deployment folder and where plugins.txt goes', async () => {
    const looked = [{ place: 'the setting', answer: 'not set' }];
    const value = instanceValueFixture({
      gameName: 'Fallout 4', holdsRepository: true, gameFolderLinks: 3,
      gameFolder: { kind: 'notFound', looked, setting: 'modbench.gameFolder' },
      programVersions: { kind: 'unresolved' },
    });
    const asked: string[] = [];
    const { client } = await clientOf(new FakeInstance(value), undefined, undefined, {
      folder: () => '/deploy',
      pluginsTxtPlace: (game, folder) => { asked.push(`${game}@${folder}`); return Promise.resolve({ folder: '/prefix/plugins' }); },
    });

    expect(await read(client, 'list_profiles')).toEqual({
      active: 'Default', profiles: ['Default'],
      game: { name: 'Fallout 4', folder: { kind: 'notFound', looked, setting: 'modbench.gameFolder' }, versions: { kind: 'unresolved' } },
      gameFolderLinks: 3, holdsRepository: true,
      deployment: { folder: '/deploy', pluginsTxt: { folder: '/prefix/plugins' } },
    });
    expect(asked).toEqual(['Fallout 4@/deploy']);
  });

  it('reads a found game folder with its root and the versions of the game and its script extender', async () => {
    const gameFolder = { kind: 'found' as const, root: '/g', dataFolder: '/g/Data' };
    const programVersions = { kind: 'found' as const, game: { kind: 'read' as const, program: 'Fallout4.exe', version: '1.10' }, extender: { kind: 'notFound' as const, program: 'f4se_loader.exe' } };
    const { client } = await clientOf(new FakeInstance(instanceValueFixture({ gameFolder, programVersions })));

    expect(await read(client, 'list_profiles')).toMatchObject({ game: { folder: gameFolder, versions: programVersions } });
  });

  it('reads no deployment folder as none, and asks nothing of where plugins.txt goes', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE), undefined, undefined, {
      folder: () => undefined, pluginsTxtPlace: () => Promise.reject(new Error('asked')),
    });

    expect(await read(client, 'list_profiles')).toMatchObject({ deployment: { folder: null } });
  });

  it('reads the mod order with each entry enabled or not', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_mods')).toEqual([
      { kind: 'runtimeOutput', name: 'Overwrite', fileCount: 0 },
      { kind: 'separator', name: 'Textures', enabled: true },
      { kind: 'mod', name: 'Big Rocks', enabled: false },
    ]);
  });

  it('reads each mod\'s metadata as its row shows it, and the Overwrite row with its file count', async () => {
    const value = instanceValueFixture({
      mods: [{ kind: 'mod', name: 'Big Rocks', enabled: true, version: '1.2', updateAvailable: true, nexusId: '12', installationFileName: 'rocks.7z' }],
      listedSourceMods: new Set(['Big Rocks']),
      paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map(), sourceDirs: new Map([['Big Rocks', '/i/source/Big Rocks']]) },
      overwriteFiles: [fileIn('/i/runtime', 'a.txt'), fileIn('/i/runtime', 'b.txt')],
    });
    const { client } = await clientOf(new FakeInstance(value));

    expect(await read(client, 'list_mods')).toEqual([
      { kind: 'runtimeOutput', name: 'Overwrite', fileCount: 2 },
      { kind: 'mod', name: 'Big Rocks', enabled: true, version: '1.2', updateAvailable: true, nexusId: '12', installationFileName: 'rocks.7z', sourceFolder: '/i/source/Big Rocks' },
    ]);
  });

  it('reads the plugin order by line, each plugin with its origin and whether it is enabled', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_plugins')).toMatchObject({ plugins: [
      { name: 'A.esp', origin: 'Big Rocks', line: 0, enabled: true, winning: true },
      { name: 'B.esp', origin: 'Big Rocks', line: 1, enabled: false, winning: true },
    ] });
  });

  it('reads each broken sorting rule in its words, with its level, its plugins and the move it offers', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));
    const master: (typeof sortingRead.rules)[number] = { level: 'error', reason: 'A.esp loads before its master B.esp.', plugins: [{ origin: 'Big Rocks', filename: 'A.esp' }, { origin: 'Big Rocks', filename: 'B.esp' }] };
    const dirty: (typeof sortingRead.rules)[number] = { level: 'info', reason: 'A.esp is dirty.', plugins: [{ origin: 'Big Rocks', filename: 'A.esp' }] };
    sortingRead.rules = [master, dirty];
    sortingRead.moves = [{ rule: master, mover: { name: 'A.esp', origin: 'Big Rocks' }, drop: { kind: 'after', name: 'B.esp' } }];

    expect(await read(client, 'list_sorting_rules')).toEqual({ rules: [
      {
        rule: 'A.esp loads before its master B.esp.', level: 'error',
        plugins: [{ name: 'A.esp', origin: 'Big Rocks' }, { name: 'B.esp', origin: 'Big Rocks' }],
        suggestedMove: { plugin: { name: 'A.esp', origin: 'Big Rocks' }, side: 'after', beside: 'B.esp' },
      },
      { rule: 'A.esp is dirty.', level: 'info', plugins: [{ name: 'A.esp', origin: 'Big Rocks' }] },
    ] });
  });

  it('refuses the sorting rules while the order is not judged, naming why, rather than answer no rules', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));
    sortingRead.notJudged = 'Still indexing…';

    expect(await call(client, 'list_sorting_rules')).toEqual({
      isError: true, text: 'The sorting rules are not judged yet: Still indexing…',
    });
  });

  it('refuses in part when the game folder is not found, answering the lines with why the plugins loaded with no line are missing, in the Output', async () => {
    const { client, warned } = await clientOf(new FakeInstance(VALUE));

    const { isError, text } = await call(client, 'list_plugins');

    expect({ isError, answer: JSON.parse(text) as unknown, warned }).toMatchObject({
      isError: true, answer: { noLineMissing: 'The game folder was not found.', plugins: [{ name: 'A.esp' }, { name: 'B.esp' }] },
      warned: ['[agent] list_plugins: The game folder was not found.'],
    });
  });

  it('reads the plugins the game loads with no line first, with no line', async () => {
    const { client } = await clientOf(new FakeInstance({ ...VALUE, pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN, path: '/game/Data/Fallout4.esm' }] }));

    expect(await read(client, 'list_plugins')).toEqual({ plugins: [
      { name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN, line: null, enabled: true, winning: true, ...NOT_READ },
      { name: 'A.esp', origin: 'Big Rocks', line: 0, enabled: true, winning: true, ...NOT_READ },
      { name: 'B.esp', origin: 'Big Rocks', line: 1, enabled: false, winning: true, ...NOT_READ },
    ] });
  });

  it('reads what the Plugins view shows of each plugin, its own by origin: its statuses, whether it is read-only, whether it is a compiled plugin and its masters', async () => {
    const failed: PluginShown = { statuses: [{ status: 'failed to read', tooltip: 'Failed to read: Malformed record' }], readOnly: true, compiled: false, masters: ['Fallout4.esm'] };
    const game: PluginShown = { statuses: [], readOnly: true, compiled: false, masters: [] };
    shownRead.answer = new Map([
      [exactPluginAddressKey({ name: 'A.esp', origin: 'Big Rocks' }), failed],
      [exactPluginAddressKey({ name: 'B.esp', origin: 'Other Mod' }), failed],
      [exactPluginAddressKey({ name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN }), game],
    ]);
    const { client } = await clientOf(new FakeInstance({ ...VALUE, pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN, path: '/game/Data/Fallout4.esm' }] }));

    expect(await read(client, 'list_plugins')).toEqual({ plugins: [
      { name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN, line: null, enabled: true, winning: true, ...game },
      { name: 'A.esp', origin: 'Big Rocks', line: 0, enabled: true, winning: true, ...failed },
      { name: 'B.esp', origin: 'Big Rocks', line: 1, enabled: false, winning: true, ...NOT_READ },
    ] });
  });

  describe('a line whose file is not on disk', () => {
    beforeEach(() => { fired.calls = []; });
    const cloned = (...names: string[]) => new FakeInstance({
      ...VALUE, holdsRepository: true, dataFolderPlugins: { kind: 'listed', names: new Set(['temp.esp']) },
      mods: [{ kind: 'mod', name: 'Acc Mod B', enabled: true }, { kind: 'mod', name: 'Acc Mod C', enabled: true }],
      plugins: names.map((name, line) => ({ name, path: undefined, origin: DATA_DIRECTORY_ORIGIN, line, enabled: true, winning: true })),
    });

    it.each([
      ['a manifest names it', [status('Acc Mod C', { gone: ['AccC.esp'] })], 'Acc Mod C'],
      ['no manifest names it', [status('Acc Mod C')], DATA_DIRECTORY_ORIGIN],
    ])('has as its origin the mod whose manifest names it: %s', async (_case, answer, origin) => {
      statusRead.answer = answer;

      expect(await read((await clientOf(cloned('AccC.esp'))).client, 'list_plugins')).toMatchObject({ plugins: [{ name: 'AccC.esp', origin }] });
    });

    it('reads what the Plugins view shows of a line its manifest names, the view\'s row as the load order holds it', async () => {
      statusRead.answer = [status('Acc Mod C', { gone: ['AccC.esp'] })];
      const notRestored: PluginShown = { ...NOT_READ, statuses: [{ status: 'not restored', tooltip: 'Not restored: its mod\'s manifest names it, and the mod\'s folder lacks it.' }] };
      shownRead.answer = new Map([[exactPluginAddressKey({ name: 'AccC.esp', origin: DATA_DIRECTORY_ORIGIN }), notRestored]]);

      expect(await read((await clientOf(cloned('AccC.esp'))).client, 'list_plugins')).toMatchObject({ plugins: [{ name: 'AccC.esp', origin: 'Acc Mod C', ...notRestored }] });
    });

    it('answers in part when a mod\'s status cannot be read, naming each line it could not place', async () => {
      statusRead.answer = [status('Acc Mod C', { gone: ['AccC.esp'], unreadable: 'git is gone' })];
      const { client } = await clientOf(cloned('AccC.esp', 'Other.esp'));

      const { isError, text } = await call(client, 'list_plugins');

      expect({ isError, answer: JSON.parse(text) as unknown }).toMatchObject({
        isError: true,
        answer: {
          plugins: [{ name: 'AccC.esp', origin: 'Acc Mod C' }, { name: 'Other.esp', origin: DATA_DIRECTORY_ORIGIN }],
          notRestoredUndecided: { lines: ['Other.esp'], reason: 'the status of "Acc Mod C" could not be read: git is gone' },
        },
      });
    });

    it('answers in part for a line a lower mod names when the mod above it cannot be read', async () => {
      statusRead.answer = [status('Acc Mod B', { unreadable: 'git is gone' }), status('Acc Mod C', { gone: ['AccC.esp'] })];
      const { client } = await clientOf(cloned('AccC.esp'));

      const { isError, text } = await call(client, 'list_plugins');

      expect({ isError, answer: JSON.parse(text) as unknown }).toMatchObject({
        isError: true, answer: { plugins: [{ name: 'AccC.esp', origin: 'Acc Mod C' }], notRestoredUndecided: { lines: ['AccC.esp'] } },
      });
    });

    it('asks for the manifests only when a plugin is named with its origin', async () => {
      statusRead.asked = 0;
      fired.outcome = { applied: true, outcome: { landed: ['AccC.esp'], refused: [] } };
      const { client } = await clientOf(cloned('AccC.esp'));

      await call(client, 'plugin_enable', { argument: [{ name: 'AccC.esp' }] });

      expect(statusRead.asked).toBe(0);
    });

    it.each([
      ['plugin_enable', 'modbench.plugin.enable', {}],
      ['plugin_move', 'modbench.plugin.move', { drop: { kind: 'winningEnd' } }],
    ])('fires %s on the line named by the origin list_plugins shows, as the load order holds it', async (tool, command, options) => {
      statusRead.answer = [status('Acc Mod C', { gone: ['AccC.esp'] })];
      fired.outcome = { applied: true, outcome: { landed: ['AccC.esp'], refused: [] } };
      const { client } = await clientOf(cloned('AccC.esp'));

      await call(client, tool, { argument: [{ name: 'AccC.esp', origin: 'Acc Mod C' }], options });

      expect(fired.calls).toEqual([[command, new AgentCall([{ kind: 'plugin', plugin: { name: 'AccC.esp', origin: DATA_DIRECTORY_ORIGIN } }], options)]]);
    });
  });

  describe('reading each mod\'s status against its manifest', () => {
    const inRepository = new FakeInstance({
      ...VALUE, holdsRepository: true,
      modFolders: [
        { kind: 'mod', name: 'Big Rocks', path: '/i/mods/Big Rocks', modName: 'Big Rocks' },
        { kind: 'separator', name: 'Textures', path: '/i/mods/Textures_separator', modName: 'Textures_separator' },
        { kind: 'mod', name: 'InAnotherProfile', path: '/i/mods/InAnotherProfile', modName: 'InAnotherProfile' },
      ],
    });
    beforeEach(() => { statusRead.asked = 0; });

    it('answers each status Mod status derived, by the name of its mod, and none for a separator', async () => {
      statusRead.answer = [status('Big Rocks', { differing: ['a.nif'], notInPackage: ['b.nif'], otherBytes: ['c.nif'] }), status('Textures_separator', { noManifest: true })];
      const { client } = await clientOf(inRepository);

      expect(await read(client, 'list_mod_statuses')).toEqual([
        { mods: ['Big Rocks'], differing: ['a.nif'], notInPackage: ['b.nif'], otherBytes: ['c.nif'] },
      ]);
    });

    it('names a file by its own path, the mod manager\'s mark left out', async () => {
      const marked = new FakeInstance({
        ...VALUE, holdsRepository: true,
        modFolders: [{ kind: 'mod', name: 'Big Rocks', path: '/i/mods/Big Rocks', modName: 'Big Rocks' }],
        filesByMod: new Map([['Big Rocks', [fileIn('/m', 'Textures/a.dds.mohidden'), fileIn('/m', 'b.nif'), fileIn('/m', 'c.nif.mohidden')]]]),
      });
      statusRead.answer = [status('Big Rocks', { differing: ['Textures/a.dds.mohidden'], namedByNoLine: ['c.nif.mohidden', 'b.nif'], gone: ['Gone.nif'] })];
      const { client } = await clientOf(marked);

      expect(await read(client, 'list_mod_statuses')).toEqual([
        { mods: ['Big Rocks'], differing: ['Textures/a.dds'], namedByNoLine: ['c.nif', 'b.nif'], gone: ['Gone.nif'] },
      ]);
    });

    it('groups the mods of one status, leaving out each empty member', async () => {
      statusRead.answer = [status('Big Rocks', { noManifest: true }), status('InAnotherProfile', { noManifest: true })];
      const { client } = await clientOf(inRepository);

      expect(await read(client, 'list_mod_statuses')).toEqual([{ mods: ['Big Rocks', 'InAnotherProfile'], noManifest: true }]);
    });

    it('groups mods that match their manifests whatever their manifest file and package', async () => {
      const lone = (name: string) => ({ kind: 'installationFile' as const, name, size: 1, hash: 'h' });
      statusRead.answer = [
        status('Big Rocks', { manifestFile: '/i/mods/Big Rocks/Big Rocks.manifest.json', packages: [lone('a.7z')] }),
        status('InAnotherProfile', { manifestFile: '/i/mods/InAnotherProfile/InAnotherProfile.manifest.json', packages: [lone('b.7z')] }),
      ];
      const { client } = await clientOf(inRepository);

      expect(await read(client, 'list_mod_statuses')).toEqual([{ mods: ['Big Rocks', 'InAnotherProfile'] }]);
    });

    it('groups a mod whose whole folder git holds with those that match their manifests, adding no member of its own', async () => {
      statusRead.answer = [status('Big Rocks', { heldWhole: true }), status('InAnotherProfile')];
      const { client } = await clientOf(inRepository);

      expect(await read(client, 'list_mod_statuses')).toEqual([{ mods: ['Big Rocks', 'InAnotherProfile'] }]);
    });

    it('leaves out the packages of a mod made from several, which list_problems gives as a note', async () => {
      const packages = [{ kind: 'installationFile' as const, name: 'a.7z', size: 1, hash: 'h' }, { kind: 'gameFolder' as const }];
      statusRead.answer = [status('Big Rocks', { packages })];
      const { client } = await clientOf(inRepository);

      expect(await read(client, 'list_mod_statuses')).toEqual([{ mods: ['Big Rocks'] }]);
    });

    it('answers every member ModStatus holds but the ones it leaves out', async () => {
      statusRead.answer = [{ ...status('Big Rocks'), addedLater: ['x.nif'] } as ModStatus];
      const { client } = await clientOf(inRepository);

      expect(await read(client, 'list_mod_statuses')).toEqual([{ mods: ['Big Rocks'], addedLater: ['x.nif'] }]);
    });

    it('refuses an instance that is no repository, which has no manifest to compare', async () => {
      const { client } = await clientOf(new FakeInstance(VALUE));

      const refusal = await call(client, 'list_mod_statuses');

      expect(refusal.isError).toBe(true);
      expect(refusal.text).toContain('repository');
      expect(statusRead.asked).toBe(0);
    });
  });

  it('reads each downloaded file as its row shows it, with its upgrade targets', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));

    expect(await read(client, 'list_downloads')).toEqual([{
      name: 'rocks.7z', displayName: 'Rocks', status: 'Installed', excluded: false, hasMeta: true, size: 5, mtimeMs: 7,
      modID: '12', fileID: '34', version: '1.2', modName: 'Big Rocks', gameName: 'fallout4', author: 'Ann',
      upgrades: [{ modName: 'Big Rocks', version: '1.0', tier: 'fileId' }, { modName: 'Other Rocks' }],
    }]);
  });

  it('reads every problem Modbench shows, with its code, and none another extension shows', async () => {
    const { client } = await clientOf(new FakeInstance(VALUE));
    const problem = (severity: number, line: number, message: string, source?: string, code?: unknown) =>
      ({ severity, range: { start: { line } }, message, source, code });
    diagnosticsHeld.held = [
      [{ scheme: 'file', fsPath: '/i/Rocks.esp' }, [
        problem(1, 0, 'malformed', 'Modbench', { value: 'decompile and repair', target: {} }),
        problem(1, 0, 'not ours', 'ESLint'),
        problem(1, 0, 'no source'),
      ]],
      [{ scheme: 'file', fsPath: '/i/source/Rocks/plugin-source/Rocks.esp.json' }, [problem(0, 4, 'bad reference', 'Modbench'), problem(2, 9, 'odd value', 'Modbench', 7)]],
      [{ scheme: 'untitled', fsPath: '/i/Other.esp' }, [problem(0, 0, 'not a file', 'Modbench')]],
    ];

    expect(await read(client, 'list_problems')).toEqual([
      { file: '/i/Rocks.esp', severity: 'Warning', line: 1, message: 'malformed', code: 'decompile and repair' },
      { file: '/i/source/Rocks/plugin-source/Rocks.esp.json', severity: 'Error', line: 5, message: 'bad reference' },
      { file: '/i/source/Rocks/plugin-source/Rocks.esp.json', severity: 'Information', line: 10, message: 'odd value', code: 7 },
    ]);
  });

  it('reads the value as it stands on each request', async () => {
    const instance = new FakeInstance(VALUE);
    const { client } = await clientOf(instance);
    instance.publish(instanceValueFixture({ activeProfile: 'Default', profiles: ['Default'] }));

    expect(await read(client, 'list_profiles')).toEqual({ ...NO_TOOLBOX, active: 'Default', profiles: ['Default'] });
  });

  it('refuses a read whose downloads folder is unresolved with the reason, in the Output and in no notification', async () => {
    const instance = new FakeInstance(instanceValueFixture({ downloadedFiles: { kind: 'unresolved', reason: 'no downloads folder' } }));
    const { client, lines, reporter } = await clientOf(instance);

    expect(await call(client, 'list_downloads')).toEqual({ isError: true, text: 'no downloads folder' });
    expect(lines.join('\n')).toContain('no downloads folder');
    expect(reporter.reports).toEqual([]);
  });

  describe('the standing lines it answers beside', () => {
    const EVERY_SOURCE = {
      mEdit: () => ['mEdit is Running'], plugins: () => ['plugins read failed'], sortingRules: () => ['No masterlist'],
      modList: () => ['modlist.txt is not synced'], sourceLanguage: () => ['a source problem'],
    };
    const LAST_GOOD_READ = 'Showing the last good read: the modlist is unreadable';
    const blocksOf = async (client: Awaited<ReturnType<typeof clientOf>>['client'], tool: string) =>
      CallToolResultSchema.parse(await client.callTool({ name: tool })).content.map((block) => block.type === 'text' ? block.text : '').slice(1);

    it('are the sources the tool reads, as they stand at each call', async () => {
      let said = ['modlist.txt is not synced'];
      const instance = new FakeInstance(VALUE);
      instance.fail('the modlist is unreadable');
      const { client } = await clientOf(instance, undefined, undefined, undefined, { ...NO_STANDING, modList: () => said });

      expect(await blocksOf(client, 'list_mods')).toEqual([LAST_GOOD_READ, 'modlist.txt is not synced']);

      said = [];
      expect(await blocksOf(client, 'list_mods')).toEqual([LAST_GOOD_READ]);
    });

    it('leave out the sources the tool does not read', async () => {
      const instance = new FakeInstance(VALUE);
      instance.fail('the modlist is unreadable');
      const { client } = await clientOf(instance, undefined, undefined, undefined, EVERY_SOURCE);

      expect(await blocksOf(client, 'list_profiles')).toEqual([LAST_GOOD_READ]);
    });

    it.each([
      ['list_plugins', ['mEdit is Running', 'plugins read failed', 'No masterlist']],
      ['list_sorting_rules', ['mEdit is Running', 'plugins read failed', 'No masterlist']],
      ['list_problems', ['No masterlist', 'a source problem']],
      ['read_record', ['mEdit is Running', 'plugins read failed', 'a source problem']],
    ])('reach %s with its own sources, instance lines first', async (tool, own) => {
      const instance = new FakeInstance(VALUE);
      instance.fail('the modlist is unreadable');
      const { client } = await clientOf(instance, undefined, undefined, undefined, EVERY_SOURCE);

      expect(await blocksOf(client, tool)).toEqual([LAST_GOOD_READ, ...own]);
    });

    it('say a line two sources raise once', async () => {
      const instance = new FakeInstance(VALUE);
      instance.fail('the modlist is unreadable');
      const { client } = await clientOf(instance, undefined, undefined, undefined, { ...NO_STANDING, modList: () => [LAST_GOOD_READ] });

      expect(await blocksOf(client, 'list_mods')).toEqual([LAST_GOOD_READ]);
    });
  });

  it.each([
    ['before the instance has been read', undefined, 'The instance has not been read yet.'],
    ['whose first read failed with the failure, as the view\'s error row does', 'Modbench does not support Oblivion', 'Failed to load: Modbench does not support Oblivion'],
  ])('refuses a read %s', async (_case, readFailure, text) => {
    const instance = new FakeInstance(VALUE, 0);
    instance.readFailure = readFailure;
    const { client } = await clientOf(instance);

    expect(await call(client, 'list_profiles')).toEqual({ isError: true, text });
  });
});

const providing = (relativePath: string, ...providers: ConflictEntry['providers']): ConflictEntry =>
  ({ relativePath, winner: `/m/${relativePath}`, winnerOrigin: providers[0] ?? RUNTIME_OUTPUT, providers });
const A = modOrigin('A');
const B = modOrigin('B');
const C = modOrigin('C');
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
    { kind: 'mod', name: 'D', enabled: false },
  ],
  overwriteFiles: [fileIn('/o', 'F.esp')],
  filesByMod: new Map([
    ['A', [fileIn('/m', 'textures/rock.dds')]],
    ['B', [fileIn('/m', 'Textures/Rock.DDS'), fileIn('/m', 'meshes/x.nif')]],
    ['C', [fileIn('/m', 'MESHES/x.nif'), fileIn('/m', 'F.esp'), fileIn('/m', 'readme.txt')]],
    ['D', [fileIn('/m', 'textures/rock.dds'), fileIn('/m', 'Docs/a.txt'), fileIn('/m', 'docs/A.TXT')]],
  ]),
  files: asLookup(
    providing('textures/rock.dds', A, B),
    providing('meshes/x.nif', B, C),
    providing('f.esp', RUNTIME_OUTPUT, C),
    providing('readme.txt', C),
  ),
});

describe('the agent server, reading file order conflicts', () => {
  it('reads, for each mod, the files it wins over which mods and the files it loses to which winner', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] })).toMatchObject([
      { mod: 'A', enabled: true, wins: [{ file: 'textures/rock.dds', over: ['B'] }], loses: [] },
      { mod: 'B', enabled: true, wins: [{ file: 'meshes/x.nif', over: ['C'] }], loses: [{ file: 'Textures/Rock.DDS', winner: 'A' }] },
      { mod: 'C', enabled: true, wins: [], loses: [{ file: 'F.esp', winner: 'Overwrite' }, { file: 'MESHES/x.nif', winner: 'B' }] },
    ]);
  });

  it('reads Overwrite as list_mods names it, as the winner of the files it holds', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'Overwrite', kind: 'runtimeOutput' }] })).toMatchObject([
      { mod: 'Overwrite', enabled: true, wins: [{ file: 'f.esp', over: ['C'] }], loses: [], files: [{ file: 'F.esp', excluded: false, gotten: true }] },
    ]);
  });

  describe('a mod named Overwrite', () => {
    const withOverwriteMod = new FakeInstance({
      ...CONFLICTED, mods: [...CONFLICTED.mods, { kind: 'mod', name: 'Overwrite', enabled: true }],
      filesByMod: new Map([...CONFLICTED.filesByMod, ['Overwrite', [fileIn('/m', 'own.txt')]]]),
    });

    it('is told from Overwrite by its kind, each row holding its own files and the files it wins', async () => {
      const { client } = await clientOf(withOverwriteMod);

      expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'Overwrite', kind: 'runtimeOutput' }, { name: 'Overwrite', kind: 'mod' }] })).toMatchObject([
        { kind: 'runtimeOutput', mod: 'Overwrite', wins: [{ file: 'f.esp', over: ['C'] }], files: [{ file: 'F.esp' }] },
        { kind: 'mod', mod: 'Overwrite', wins: [], files: [{ file: 'own.txt' }] },
      ]);
    });

    it('is refused as a name with no kind, listing each thing it means', async () => {
      const { client } = await clientOf(withOverwriteMod);

      expect(await call(client, 'list_file_conflicts', { mods: [{ name: 'Overwrite' }] })).toEqual({
        isError: true, text: '"Overwrite" means more than one thing: mod Overwrite; runtimeOutput Overwrite. Name it with its kind.',
      });
    });
  });

  it('says a disabled mod is disabled, so its empty answer is never read as no conflicts', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'D' }] })).toMatchObject([{ mod: 'D', enabled: false, wins: [], loses: [] }]);
  });

  it('reads every mod, and no separator, when it is given no mods', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts')).toMatchObject([{ mod: 'A' }, { mod: 'Textures' }, { mod: 'B' }, { mod: 'C' }, { mod: 'D' }]);
  });

  it('names a mod apart from a separator of the same name by which of the two it is', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'Textures', kind: 'mod' }] })).toMatchObject([{ mod: 'Textures', enabled: true, wins: [], loses: [] }]);
    const separator = await call(client, 'list_file_conflicts', { mods: [{ name: 'Textures', kind: 'separator' }] });
    expect(separator).toEqual({ isError: true, text: '"Textures" is a separator; it has no files.' });
  });

  it('reads every file of a mod: whether it is excluded, whether the game gets it, and the publisher tags that cover it', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'B' }, { name: 'D' }] })).toMatchObject([
      { files: [{ file: 'Textures/Rock.DDS', excluded: false, gotten: false, publisherTags: [] }, { file: 'meshes/x.nif', excluded: false, gotten: true, publisherTags: [] }] },
      {
        files: [
          { file: 'Docs/a.txt', excluded: false, gotten: false, publisherTags: [] },
          { file: 'docs/A.TXT', excluded: false, gotten: false, publisherTags: [] },
          { file: 'textures/rock.dds', excluded: false, gotten: false, publisherTags: [] },
        ],
      },
    ]);
  });

  it('reads a file the game gets, an excluded file and a publisher tag as the Mods view shows them, with the mod\'s indicators', async () => {
    const value = instanceValueFixture({
      mods: [{ kind: 'mod', name: 'E', enabled: true, updateAvailable: true }],
      filesByMod: new Map([['E', [fileIn('/e', 'only.txt'), fileIn('/e', 'skip.txt.mohidden')]]]),
      files: asLookup(providing('only.txt', modOrigin('E'))),
      publisherConfiguration: {
        kind: 'read', listed: () => [], pathProblems: [],
        covering: (path: string) => (path === '/e/only.txt' ? [{ name: 'Patched', badge: 'P', marksPaths: true }, { name: 'Mod only', badge: 'M', marksPaths: false }] : []),
      },
    });
    const { client } = await clientOf(new FakeInstance(value));

    expect(await read(client, 'list_file_conflicts', { mods: [{ name: 'E' }] })).toMatchObject([{
      indicators: ['containsExcludedFiles', 'updateAvailable'],
      files: [
        { file: 'only.txt', excluded: false, gotten: true, publisherTags: ['Patched'] },
        { file: 'skip.txt', excluded: true, gotten: false, publisherTags: [] },
      ],
    }]);
  });

  it('refuses a name that means a mod and a separator, listing each as the agent can name it, and picks neither', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    const refusal = await call(client, 'list_file_conflicts', { mods: [{ name: 'A' }, { name: 'Textures' }] });

    expect(refusal).toEqual({
      isError: true,
      text: '"Textures" means more than one thing: separator Textures; mod Textures. Name it with its kind.',
    });
  });

  it('refuses every name that cannot be resolved in one answer, so several names are named as a selection is', async () => {
    const { client } = await clientOf(new FakeInstance(CONFLICTED));

    const refusal = await call(client, 'list_file_conflicts', { mods: [{ name: 'Nope' }, { name: 'Textures' }, { name: 'A' }] });

    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain('Nothing is named "Nope".');
    expect(refusal.text).toContain('"Textures" means more than one thing');
  });
});

const CONFLICTED_WITH_DOWNLOADED_FILES = { ...CONFLICTED, downloadedFiles: VALUE.downloadedFiles };

describe('the agent server, resolving names against the instance', () => {
  const resolve = async (args: Record<string, unknown>) => call((await clientOf(new FakeInstance(CONFLICTED_WITH_DOWNLOADED_FILES))).client, 'resolve_instance_names', args);

  it('names a downloaded file by its file name', async () => {
    expect(await resolve({ downloads: ['rocks.7z'] })).toEqual({ isError: false, text: JSON.stringify({ downloads: ['rocks.7z'], files: [] }) });
  });

  it('refuses a downloaded file nothing is named', async () => {
    expect(await resolve({ downloads: ['rocks.7z', 'gone.7z'] })).toEqual({ isError: true, text: 'Nothing is named "gone.7z" among the downloaded files.' });
  });

  it('refuses a downloaded file when the downloads folder is unresolved, with the reason', async () => {
    const { client } = await clientOf(new FakeInstance(instanceValueFixture({ downloadedFiles: { kind: 'unresolved', reason: 'no downloads folder' } })));

    expect(await call(client, 'resolve_instance_names', { downloads: ['rocks.7z'] })).toEqual({ isError: true, text: 'no downloads folder' });
  });

  it('refuses every name that cannot be resolved in one answer, downloaded files and files in a mod together', async () => {
    const refusal = await resolve({ downloads: ['gone.7z'], files: [{ mod: { name: 'B' }, path: 'meshes/none.nif' }] });

    expect(refusal).toEqual({
      isError: true, text: 'Nothing is named "gone.7z" among the downloaded files. Nothing is named "meshes/none.nif" in mod B.',
    });
  });

  it('names a file in a mod by its path in the mod, answering the mod\'s own casing', async () => {
    expect(await resolve({ files: [{ mod: { name: 'B' }, path: 'textures/rock.dds' }] })).toEqual({
      isError: false, text: JSON.stringify({ downloads: [], files: [{ mod: 'B', file: 'Textures/Rock.DDS' }] }),
    });
  });

  it('names an excluded file by its own path, without the mod manager\'s mark, answering that path', async () => {
    const value = instanceValueFixture({
      mods: [{ kind: 'mod', name: 'B', enabled: true }],
      filesByMod: new Map([['B', [fileIn('/m', 'F4SE/Plugins/BetterConsole.mem.mohidden')]]]),
    });
    const { client } = await clientOf(new FakeInstance(value));

    expect(await call(client, 'resolve_instance_names', { files: [{ mod: { name: 'B' }, path: 'f4se/plugins/betterconsole.mem' }] })).toEqual({
      isError: false, text: JSON.stringify({ downloads: [], files: [{ mod: 'B', file: 'F4SE/Plugins/BetterConsole.mem' }] }),
    });
  });

  it('refuses a path that carries the mod manager\'s mark', async () => {
    const value = instanceValueFixture({
      mods: [{ kind: 'mod', name: 'B', enabled: true }],
      filesByMod: new Map([['B', [fileIn('/m', 'a.mem.mohidden')]]]),
    });
    const { client } = await clientOf(new FakeInstance(value));

    expect(await call(client, 'resolve_instance_names', { files: [{ mod: { name: 'B' }, path: 'a.mem.mohidden' }] }))
      .toEqual({ isError: true, text: 'Nothing is named "a.mem.mohidden" in mod B.' });
  });

  it('names a file of Overwrite by its path there', async () => {
    expect(await resolve({ files: [{ mod: { name: 'Overwrite', kind: 'runtimeOutput' }, path: 'f.esp' }] })).toEqual({
      isError: false, text: JSON.stringify({ downloads: [], files: [{ mod: 'Overwrite', file: 'F.esp' }] }),
    });
  });

  it('names a file of Overwrite by the origin a gesture reply gives it, which carries no name', async () => {
    expect(await resolve({ files: [{ mod: { kind: 'runtimeOutput' }, path: 'f.esp' }] })).toEqual({
      isError: false, text: JSON.stringify({ downloads: [], files: [{ mod: 'Overwrite', file: 'F.esp' }] }),
    });
  });

  it('refuses a mod named with no name', async () => {
    expect(await resolve({ files: [{ mod: { kind: 'mod' }, path: 'f.esp' }] })).toMatchObject({ isError: true, text: expect.stringContaining('needs a name') as unknown });
  });

  it('refuses a path the mod has no file at', async () => {
    expect(await resolve({ files: [{ mod: { name: 'B' }, path: 'meshes/none.nif' }] })).toEqual({ isError: true, text: 'Nothing is named "meshes/none.nif" in mod B.' });
  });

  it('refuses a path that means two files of the mod, listing each as the mod has it', async () => {
    expect(await resolve({ files: [{ mod: { name: 'D' }, path: 'DOCS/a.TXT' }] })).toEqual({
      isError: true, text: '"DOCS/a.TXT" means more than one thing in mod D: Docs/a.txt; docs/A.TXT.',
    });
  });

  it('prefers the file whose path is exactly the one given', async () => {
    expect(await resolve({ files: [{ mod: { name: 'D' }, path: 'docs/A.TXT' }] })).toEqual({
      isError: false, text: JSON.stringify({ downloads: [], files: [{ mod: 'D', file: 'docs/A.TXT' }] }),
    });
  });

  it('refuses a separator together with every other unresolved name in one answer', async () => {
    const refusal = await resolve({ files: [{ mod: { name: 'Textures', kind: 'separator' }, path: 'x' }, { mod: { name: 'B' }, path: 'meshes/none.nif' }] });

    expect(refusal).toEqual({
      isError: true, text: '"Textures" is a separator; it has no files. Nothing is named "meshes/none.nif" in mod B.',
    });
  });

  it('refuses a mod that is a separator or shares its name with one, as the conflicts read does', async () => {
    const refusal = await resolve({ files: [{ mod: { name: 'Textures' }, path: 'x' }] });

    expect(refusal).toEqual({ isError: true, text: '"Textures" means more than one thing: separator Textures; mod Textures. Name it with its kind.' });
  });
});

describe('the agent server, resolving names through mEdit', () => {
  const shared = { name: 'Shared.esp', origin: 'ModA' };

  it('hands mEdit the names, with their origins, and answers what each means', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', [{ plugin: shared }, { formKey: '000800:Shared.esp', editorId: 'SharedNpc' }]);
    const { client } = await clientOf(new FakeInstance(VALUE), mEdit);

    const named = await read(client, 'resolve_names', { names: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }] });

    expect(mEdit.calls).toContainEqual({ method: 'resolveNames', args: [[{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }]] });
    expect(named).toEqual([{ plugin: shared }, { formKey: '000800:Shared.esp', editorId: 'SharedNpc' }]);
  });

  it('refuses with mEdit\'s own listing of the matches, copying none of it', async () => {
    const mEdit = new InMemoryMEditClient();
    const listing = '"Shared.esp" means more than one thing: plugin Shared.esp (origin ModA); plugin Shared.esp (origin ModB).';
    mEdit.setQueryAnswer('resolveNames', { failed: 'refused', refusal: listing });
    const { client } = await clientOf(new FakeInstance(VALUE), mEdit);

    expect(await call(client, 'resolve_names', { names: [{ name: 'Shared.esp' }] })).toEqual({ isError: true, text: listing });
  });
});

describe('the agent server, failing', () => {
  it('answers a failure that is not a refusal with its message, in the Output and in no notification', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.selectRows = () => Promise.reject(new Error('socket hang up'));
    const { client, lines, reporter } = await clientOf(new FakeInstance(VALUE), mEdit);

    expect(await call(client, 'select_rows', { sql: 'SELECT 1' })).toEqual({ isError: true, text: 'socket hang up' });
    expect(lines).toEqual(['[agent] select_rows: socket hang up']);
    expect(reporter.reports).toEqual([]);
  });
});

describe('the agent server, selecting records through mEdit', () => {
  it('hands mEdit the statement as given and answers the rows it selects', async () => {
    const mEdit = new InMemoryMEditClient();
    const rows = [{ editorId: 'SharedNpc' }];
    mEdit.setQueryAnswer('selectRows', rows);
    const { client } = await clientOf(new FakeInstance(VALUE), mEdit);

    const answered = await read(client, 'select_rows', { sql: 'SELECT editorId FROM records' });

    expect(mEdit.calls).toContainEqual({ method: 'selectRows', args: ['SELECT editorId FROM records'] });
    expect(answered).toEqual(rows);
  });

  it('refuses with the database\'s reason', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('selectRows', { failed: 'refused', refusal: 'Only a SELECT runs.' });
    const { client } = await clientOf(new FakeInstance(VALUE), mEdit);

    expect(await call(client, 'select_rows', { sql: 'DROP TABLE records' })).toEqual({ isError: true, text: 'Only a SELECT runs.' });
  });
});

describe('the agent server, reading a record through mEdit', () => {
  const NPC = [{ formKey: '000800:A.esp', editorId: 'SharedNpc' }];

  const COPIES = comparisonOf('000800:A.esp', [
    { plugin: 'A.esp', origin: 'Big Rocks', isWinner: false },
    { plugin: 'B.esp', origin: 'Big Rocks', isWinner: true },
  ]);

  const pluginListed = (name: string, extra: { isImmutable?: boolean; isCompiledPlugin?: boolean } = {}) => ({
    name, origin: 'Big Rocks', path: `/m/${name}`, isLight: false, isMaster: false, isBlueprint: false, masters: [], isImmutable: false,
    inLoadOrder: true, hasMatchingRecords: true, isCompiledPlugin: true, hasParseFailure: false, ...extra,
  });
  const PLUGINS = [pluginListed('A.esp'), pluginListed('B.esp')];
  const ENABLED = {
    ...VALUE,
    mods: [{ kind: 'mod' as const, name: 'Big Rocks', enabled: true }],
    plugins: VALUE.plugins.map((row) => ({ ...row, enabled: true })),
  };
  const STANDING = { loadIndex: '00', isPartialForm: false, fields: [] };

  it('answers each copy\'s load index, Partial Form, parse diagnosis, column state and the conflict state of each row and cell', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getComparison', {
      ...comparisonOf('000800:A.esp', [
        { plugin: 'A.esp', origin: 'Big Rocks', isWinner: false },
        { plugin: 'B.esp', origin: 'Big Rocks', isWinner: true },
      ]),
      diffs: [{
        fieldName: 'Name', values: {}, winnerColumn: 'B.esp|Big Rocks', noWinner: false, conflictAll: 'Conflict',
        cellStates: { 'A.esp|Big Rocks': 'ConflictLoses', 'B.esp|Big Rocks': 'ConflictWins' },
        children: [{ fieldName: 'Full', values: {}, winnerColumn: '', noWinner: false, conflictAll: 'Override', cellStates: { 'B.esp|Big Rocks': 'Override' } }],
      }, {
        fieldName: 'Weight', values: { 'A.esp|Big Rocks': 2 }, winnerColumn: '', noWinner: false, conflictAll: 'Override', cellStates: { 'B.esp|Big Rocks': 'Override' },
      }],
    });
    mEdit.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/s/x.json' });
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const answered = await read(client, 'read_record', { name: 'SharedNpc' });

    expect(answered).toMatchObject([
      { plugin: { name: 'A.esp' }, fields: [{ field: 'Name', conflictAll: 'Conflict', conflictThis: 'ConflictLoses' }, { field: 'Weight', conflictThis: 'Master' }] },
      { plugin: { name: 'B.esp' }, fields: [{ field: 'Name', conflictAll: 'Conflict', conflictThis: 'ConflictWins', children: [{ field: 'Full', conflictAll: 'Override', conflictThis: 'Override' }] }, { field: 'Weight', conflictAll: 'Override', conflictThis: 'Override' }] },
    ]);
  });

  it('answers the status the record panel\'s column header shows, from the plugin mEdit lists and where the instance stands on it', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', [pluginListed('A.esp', { isCompiledPlugin: false }), pluginListed('B.esp', { isImmutable: true })]);
    mEdit.setQueryAnswer('getComparison', COPIES);
    mEdit.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/s/x.json' });
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const answered = await read(client, 'read_record', { name: 'SharedNpc' });

    expect(answered).toMatchObject([
      { status: { label: '(read-only)', reason: expect.stringContaining('Version in Git') as unknown } },
      { status: { label: '(read-only)', reason: 'The game’s plugins are not edited.' } },
    ]);
  });

  describe('the standing the instance gives the plugin asked for', () => {
    const OVERRIDDEN_A = { name: 'A.esp', path: '/m/A.esp', origin: 'Big Rocks', line: 0, enabled: true, winning: false };
    const OTHER_A = { name: 'A.esp', path: '/m2/A.esp', origin: 'Other', line: 1, enabled: true, winning: true };
    const listed = (inLoadOrder: boolean) => [{ ...pluginListed('A.esp'), inLoadOrder }, pluginListed('B.esp')];

    const asked = async (instance: FakeInstance, plugins: ReturnType<typeof listed>, comparison: typeof COPIES) => {
      const mEdit = new InMemoryMEditClient();
      mEdit.setQueryAnswer('resolveNames', NPC);
      mEdit.setQueryAnswer('getPlugins', plugins);
      mEdit.setQueryAnswer('getComparison', comparison);
      mEdit.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/s/x.json' });
      const { client } = await clientOf(instance, mEdit);
      return {
        alone: await read(client, 'read_record', { name: 'SharedNpc', plugin: { name: 'A.esp', origin: 'Big Rocks' } }),
        all: await read(client, 'read_record', { name: 'SharedNpc' }),
      };
    };
    const comparedWithoutA = comparisonOf('000800:A.esp', [{ plugin: 'B.esp', origin: 'Big Rocks', isWinner: true }]);

    it('reads (not active) for a disabled plugin the comparison leaves out, and gives no copy of the comparison a standing', async () => {
      const { alone, all } = await asked(new FakeInstance(VALUE), listed(false), comparedWithoutA);

      expect(alone).toMatchObject({ status: { label: '(not active)' } });
      expect(all).toEqual([expect.not.objectContaining({ status: expect.anything() as unknown })]);
    });

    it('reads (overridden) for a plugin another mod\'s file overrides when the game does not load it', async () => {
      const instance = new FakeInstance({ ...ENABLED, mods: [...ENABLED.mods, { kind: 'mod' as const, name: 'Other', enabled: true }],
        plugins: [OVERRIDDEN_A, OTHER_A] });

      const { alone } = await asked(instance, listed(false), comparedWithoutA);

      expect(alone).toMatchObject({ status: { label: '(overridden)', reason: 'The game loads Other’s file instead.' } });
    });

    it('reads no standing for a plugin the game loads, though the instance says another mod\'s file overrides it', async () => {
      const instance = new FakeInstance({ ...ENABLED, mods: [...ENABLED.mods, { kind: 'mod' as const, name: 'Other', enabled: true }],
        plugins: [OVERRIDDEN_A, OTHER_A] });

      const { alone } = await asked(instance, listed(true), COPIES);

      expect(alone).not.toHaveProperty('status');
    });
  });

  it('answers a copy the game uses and I can edit with no status', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getComparison', COPIES);
    mEdit.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/s/x.json' });
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const answered = await read(client, 'read_record', { name: 'SharedNpc' });

    expect(answered).toEqual([expect.not.objectContaining({ status: expect.anything() as unknown }), expect.anything() as unknown]);
  });

  it('answers each active plugin\'s copy and marks the winner when it names no plugin', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getComparison', COPIES);
    mEdit.setQueryAnswerOnce('getCopyDocument', { kind: 'OwnFile', location: '/s/A.esp/000800.json' });
    mEdit.setQueryAnswerOnce('getCopyDocument', { kind: 'OwnFile', location: '/s/B.esp/000800.json' });
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const answered = await read(client, 'read_record', { name: 'SharedNpc' });

    expect(answered).toEqual([
      { plugin: { name: 'A.esp', origin: 'Big Rocks' }, isWinner: false, ...STANDING, kind: 'OwnFile', location: '/s/A.esp/000800.json' },
      { plugin: { name: 'B.esp', origin: 'Big Rocks' }, isWinner: true, ...STANDING, kind: 'OwnFile', location: '/s/B.esp/000800.json' },
    ]);
    expect(mEdit.calls.filter(({ method }) => method === 'getCopyDocument').map(({ args }) => args[0])).toEqual([
      { name: 'A.esp', origin: 'Big Rocks' }, { name: 'B.esp', origin: 'Big Rocks' },
    ]);
  });

  it('refuses in part when a copy cannot be read, answering the copies that read and the reason for the one that did not, in the Output', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getComparison', COPIES);
    mEdit.setQueryAnswerOnce('getCopyDocument', { failed: 'refused', refusal: 'A.esp is unreadable.' });
    mEdit.setQueryAnswerOnce('getCopyDocument', { kind: 'OwnFile', location: '/s/B.esp/000800.json' });
    const { client, warned } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const { isError, text } = await call(client, 'read_record', { name: 'SharedNpc' });

    expect({ isError, answer: JSON.parse(text) as unknown, warned }).toEqual({
      isError: true,
      answer: [
        { plugin: { name: 'A.esp', origin: 'Big Rocks' }, isWinner: false, reason: 'A.esp is unreadable.' },
        { plugin: { name: 'B.esp', origin: 'Big Rocks' }, isWinner: true, ...STANDING, kind: 'OwnFile', location: '/s/B.esp/000800.json' },
      ],
      warned: ['[agent] read_record: A.esp is unreadable.'],
    });
  });

  it('answers the one plugin\'s copy when it names the plugin', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getComparison', COPIES);
    mEdit.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/s/A.esp/000800.json' });
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const answered = await read(client, 'read_record', { name: 'SharedNpc', plugin: { name: 'b.esp' } });

    expect(mEdit.calls).toContainEqual({ method: 'getCopyDocument', args: [{ name: 'B.esp', origin: 'Big Rocks' }, '000800:A.esp'] });
    expect(answered).toEqual({ ...STANDING, kind: 'OwnFile', location: '/s/A.esp/000800.json' });
  });

  it('answers the text of a non-compiled plugin\'s copy, which has no file to open', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getCopyDocument', { kind: 'Rendered', location: 'SharedNpc.txt' });
    mEdit.setQueryAnswer('getRenderedDocument', { fileName: 'SharedNpc.txt', text: 'Name: Shared' });
    mEdit.setQueryAnswer('getComparison', COPIES);
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const answered = await read(client, 'read_record', { name: 'SharedNpc', plugin: { name: 'A.esp' } });

    expect(mEdit.calls).toContainEqual({ method: 'getRenderedDocument', args: [{ name: 'A.esp', origin: 'Big Rocks' }, '000800:A.esp'] });
    expect(answered).toEqual({ ...STANDING, kind: 'Rendered', text: 'Name: Shared' });
  });

  it.each([
    ['the plugin holds none', null],
    ['the rendering finds none', { kind: 'Rendered', location: 'SharedNpc.txt' }],
  ] as const)('refuses the copy of a plugin when %s', async (_case, copyDocument) => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getCopyDocument', copyDocument);
    mEdit.setQueryAnswer('getRenderedDocument', null);
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    expect(await call(client, 'read_record', { name: 'SharedNpc', plugin: { name: 'A.esp' } })).toEqual({ isError: true, text: 'A.esp (Big Rocks) holds no 000800:A.esp.' });
  });

  it('refuses a name that is not a record', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', [{ plugin: { name: 'A.esp', origin: 'Big Rocks' } }]);
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    expect(await call(client, 'read_record', { name: 'A.esp' })).toEqual({ isError: true, text: '"A.esp" is not a record.' });
  });

  it('refuses a record no active plugin holds', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getComparison', null);
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    expect(await call(client, 'read_record', { name: 'SharedNpc' })).toEqual({ isError: true, text: 'No active plugin holds 000800:A.esp.' });
  });

  it('lists the records that reference the record named', async () => {
    const mEdit = new InMemoryMEditClient();
    const referrers = [{ formKey: '000900:B.esp', plugin: 'B.esp', origin: 'Big Rocks', fieldPath: 'Race', recordType: 'NPC_', recordTypeName: 'Npc' }];
    mEdit.setQueryAnswer('resolveNames', NPC);
    mEdit.setQueryAnswer('getPlugins', PLUGINS);
    mEdit.setQueryAnswer('getReferences', referrers);
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    const answered = await read(client, 'list_references', { name: 'SharedNpc' });

    expect(mEdit.calls).toContainEqual({ method: 'getReferences', args: ['000800:A.esp'] });
    expect(answered).toEqual(referrers);
  });

  it('refuses with mEdit\'s listing of an ambiguous name, reading no references', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setQueryAnswer('resolveNames', { failed: 'refused', refusal: 'Ambiguous.' });
    const { client } = await clientOf(new FakeInstance(ENABLED), mEdit);

    expect(await call(client, 'list_references', { name: 'Dup' })).toEqual({ isError: true, text: 'Ambiguous.' });
    expect(mEdit.calls.map(({ method }) => method)).not.toContain('getReferences');
  });
});

describe('the agent server, running a gesture', () => {
  beforeEach(() => { fired.calls = []; fired.outcome = undefined; fired.failure = undefined; });

  const served = (value: InstanceValue = CONFLICTED) => clientOf(new FakeInstance(value));
  const fire = async (tool: string, args: Record<string, unknown> = {}, value: InstanceValue = CONFLICTED) => {
    fired.outcome = { applied: true, outcome: { landed: [], refused: [] } };
    const { client } = await served(value);
    return call(client, tool, args);
  };

  it('fires the gesture\'s command with the mods named as its Argument, and answers its outcome', async () => {
    fired.outcome = { applied: true, outcome: { landed: ['A', 'Textures'], refused: [] } };
    const { client } = await served();

    const answer = await call(client, 'mod_disable', { argument: [{ name: 'A' }, { name: 'Textures', kind: 'mod' }] });

    expect(fired.calls).toEqual([['modbench.mod.disable', new AgentCall([{ kind: 'mod', name: 'A' }, { kind: 'mod', name: 'Textures' }], {})]]);
    expect(answer).toEqual({ isError: false, text: JSON.stringify({ landed: ['A', 'Textures'], refused: [] }) });
  });

  it('fires switch with the profile named, deploy with none, and answers a deploy that left a file out as a landed one with that warning', async () => {
    fired.outcome = { applied: true, outcome: { landed: [], refused: [] } };
    const { client } = await served();

    await call(client, 'profile_switch', { argument: [{ name: 'Modding' }] });
    fired.outcome = { applied: true, wrote: true, leftOut: [{ path: 'Data/a.esp', winner: '/m/A/a.esp' }], unmanaged: [], lost: [], leftAside: [], pluginsTxt: { kind: 'unchanged', renamed: [] } };
    const answer = await call(client, 'instance_deploy', {});

    expect(fired.calls).toEqual([
      ['modbench.profile.switch', new AgentCall([{ kind: 'profile', name: 'Modding' }], {})],
      ['modbench.instance.deploy', new AgentCall([], {})],
    ]);
    expect(answer).toEqual({ isError: false, text: JSON.stringify({ landed: [], refused: [], partial: [{
      message: 'Deploy left out each file whose path holds a file it did not write:', detail: '/m/A/a.esp at Data/a.esp', severity: 'warning',
    }] }) });
  });

  it('answers a refused deploy with its refusal', async () => {
    fired.outcome = { applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' };
    const { client } = await served();

    expect(await call(client, 'instance_deploy', {})).toEqual({ isError: true, text: JSON.stringify({ refusal: 'No deployment folder: set modbench.deployment.folder.' }) });
  });

  it('refuses in part, answering what landed and what was refused and why, in the Output and in no notification', async () => {
    fired.outcome = { applied: true, outcome: { landed: ['A'], refused: [{ item: 'B', reason: 'Mod not found in modlist: B' }] } };
    const { client, lines, reporter } = await served();

    const answer = await call(client, 'mod_enable', { argument: [{ name: 'A' }, { name: 'B' }] });

    expect(answer).toEqual({ isError: true, text: JSON.stringify({ landed: ['A'], refused: [{ item: 'B', reason: 'Mod not found in modlist: B' }] }) });
    expect(lines.join('\n')).toContain('"B" (Mod not found in modlist: B)');
    expect(reporter.reports).toEqual([]);
  });

  it('logs a gesture\'s Refusal as a refusal and any other failure as an error', async () => {
    const { client, warned, errored } = await served();

    fired.failure = new Refusal('carries mods only');
    await call(client, 'mod_enable', { argument: [{ name: 'A' }] });
    fired.failure = new Error('disk gone');
    await call(client, 'mod_enable', { argument: [{ name: 'A' }] });

    expect(warned).toEqual(['[agent] mod_enable: carries mods only']);
    expect(errored).toEqual(['[agent] mod_enable: disk gone']);
  });

  it('refuses in whole, answering the command\'s refusal', async () => {
    fired.outcome = { applied: false, refusal: 'ENOENT: modlist.txt' };
    const { client, lines } = await served();

    expect(await call(client, 'mod_enable', { argument: [{ name: 'A' }] })).toEqual({ isError: true, text: JSON.stringify({ refusal: 'ENOENT: modlist.txt' }) });
    expect(lines.join('\n')).toContain('ENOENT: modlist.txt');
  });

  const plugin = (name: string, origin: string, line: number) => ({ name, origin, path: `/m/${origin}/${name}`, line, enabled: true, winning: true });
  const PLUGGED = instanceValueFixture({
    mods: [{ kind: 'mod', name: 'ModA', enabled: true }],
    plugins: [plugin('Solo.esp', 'ModA', 0), plugin('Same.esp', 'ModA', 1), { ...plugin('Same.esp', 'ModB', 2), winning: false }],
  });
  const SOLO = { kind: 'plugin' as const, plugin: { name: 'Solo.esp', origin: 'ModA' } };
  const mod = (name: string) => ({ kind: 'mod' as const, name });
  const separator = (name: string) => ({ kind: 'separator' as const, name });
  const rocks = { kind: 'downloadedFile' as const, name: 'rocks.7z' };
  const outside = { kind: 'archive' as const, path: '/elsewhere/a.7z' };
  interface GestureCase {
    name: string;
    value: InstanceValue;
    tool: string;
    args: Record<string, unknown>;
    command: string;
    argument: readonly Argument[];
    options: Record<string, unknown>;
  }
  const GESTURES: readonly GestureCase[] = [
    {
      name: 'plugin_enable names each plugin as its address, origin left out when the file name is one plugin',
      value: PLUGGED,
      tool: 'plugin_enable',
      args: { argument: [{ name: 'solo.ESP' }, { name: 'Same.esp', origin: 'ModA' }] },
      command: 'modbench.plugin.enable',
      argument: [SOLO, { kind: 'plugin', plugin: { name: 'Same.esp', origin: 'ModA' } }],
      options: {},
    },
    {
      name: 'plugin_enable names an origin as the mod manager matches names',
      value: PLUGGED,
      tool: 'plugin_enable',
      args: { argument: [{ name: 'Same.esp', origin: 'moda' }] },
      command: 'modbench.plugin.enable',
      argument: [{ kind: 'plugin', plugin: { name: 'Same.esp', origin: 'ModA' } }],
      options: {},
    },
    {
      name: 'plugin_decompile fires on an overridden copy, which has a file though no line',
      value: PLUGGED,
      tool: 'plugin_decompile',
      args: { argument: [{ name: 'Same.esp', origin: 'ModB' }] },
      command: 'modbench.plugin.decompile',
      argument: [{ kind: 'plugin', plugin: { name: 'Same.esp', origin: 'ModB' } }],
      options: {},
    },
    {
      name: 'plugin_decompile carries force as an Option',
      value: PLUGGED,
      tool: 'plugin_decompile',
      args: { argument: [{ name: 'Solo.esp' }], options: { force: true } },
      command: 'modbench.plugin.decompile',
      argument: [SOLO],
      options: { force: true },
    },
    {
      name: 'plugin_move carries the drop as an Option',
      value: PLUGGED,
      tool: 'plugin_move',
      args: { argument: [{ name: 'Solo.esp' }], options: { drop: { kind: 'before', name: 'Same.esp' } } },
      command: 'modbench.plugin.move',
      argument: [SOLO],
      options: { drop: { kind: 'before', name: 'Same.esp' } },
    },
    {
      name: 'plugin_create carries the mod it lands in as its Argument and the name as an Option',
      value: PLUGGED,
      tool: 'plugin_create',
      args: { argument: [{ name: 'ModA' }], options: { name: 'New.esp' } },
      command: 'modbench.plugin.create',
      argument: [mod('ModA')],
      options: { name: 'New.esp' },
    },
    {
      name: 'plugin_create names a mod that shares its name with a separator by its kind',
      value: CONFLICTED,
      tool: 'plugin_create',
      args: { argument: [{ name: 'Textures', kind: 'mod' }], options: { name: 'New.esp' } },
      command: 'modbench.plugin.create',
      argument: [mod('Textures')],
      options: { name: 'New.esp' },
    },
    {
      name: 'plugin_create takes a mod named without regard to case, as its own spelling',
      value: PLUGGED,
      tool: 'plugin_create',
      args: { argument: [{ name: 'moda' }], options: { name: 'New.esp' } },
      command: 'modbench.plugin.create',
      argument: [mod('ModA')],
      options: { name: 'New.esp' },
    },
    {
      name: 'plugin_create carries Overwrite, as list_mods names it, as the overwrite Argument',
      value: PLUGGED,
      tool: 'plugin_create',
      args: { argument: [{ name: 'Overwrite', kind: 'runtimeOutput' }], options: { name: 'New.esp' } },
      command: 'modbench.plugin.create',
      argument: [{ kind: 'runtimeOutput' }],
      options: { name: 'New.esp' },
    },
    {
      name: 'plugin_rename carries the one plugin as its Argument and the new name as an Option',
      value: PLUGGED,
      tool: 'plugin_rename',
      args: { argument: { name: 'Solo.esp' }, options: { name: 'Lone.esp' } },
      command: 'modbench.plugin.rename',
      argument: [SOLO],
      options: { name: 'Lone.esp' },
    },
    {
      name: 'plugin_load_after carries the plugins as its Argument and the file names they load after as an Option',
      value: PLUGGED,
      tool: 'plugin_load_after',
      args: { argument: [{ name: 'Solo.esp' }], options: { after: [{ name: 'Same.esp' }] } },
      command: 'modbench.plugin.loadAfter',
      argument: [SOLO],
      options: { after: [{ name: 'Same.esp' }] },
    },
    {
      name: 'separator_add anchors on a mod',
      value: CONFLICTED,
      tool: 'separator_add',
      args: { argument: [{ name: 'B' }], options: { name: 'New' } },
      command: 'modbench.separator.add',
      argument: [mod('B')],
      options: { name: 'New' },
    },
    {
      name: 'separator_add anchors on a separator',
      value: CONFLICTED,
      tool: 'separator_add',
      args: { argument: [{ name: 'Textures', kind: 'separator' }], options: { name: 'New' } },
      command: 'modbench.separator.add',
      argument: [separator('Textures')],
      options: { name: 'New' },
    },
    {
      name: 'separator_rename carries the one separator as its Argument and the new name as an Option',
      value: CONFLICTED,
      tool: 'separator_rename',
      args: { argument: [{ name: 'Textures' }], options: { name: 'Skins' } },
      command: 'modbench.separator.rename',
      argument: [separator('Textures')],
      options: { name: 'Skins' },
    },
    {
      name: 'separator_delete carries the separators named',
      value: CONFLICTED,
      tool: 'separator_delete',
      args: { argument: [{ name: 'Textures' }] },
      command: 'modbench.separator.delete',
      argument: [separator('Textures')],
      options: {},
    },
    {
      name: 'mod_move carries the place and end as Options',
      value: CONFLICTED,
      tool: 'mod_move',
      args: { argument: [{ name: 'B' }], options: { place: { kind: 'separator', name: 'Textures' }, end: 'winning' } },
      command: 'modbench.mod.move',
      argument: [mod('B')],
      options: { place: { kind: 'separator', name: 'Textures' }, end: 'winning' },
    },
    {
      name: 'mod_move names a mod as the mod manager matches names, firing it as the value spells it',
      value: CONFLICTED,
      tool: 'mod_move',
      args: { argument: [{ name: 'b' }], options: { place: { kind: 'separator', name: 'textures' }, end: 'winning' } },
      command: 'modbench.mod.move',
      argument: [mod('B')],
      options: { place: { kind: 'separator', name: 'Textures' }, end: 'winning' },
    },
    {
      name: 'mod_move takes a separator named as a separator, not the mod of that name',
      value: CONFLICTED,
      tool: 'mod_move',
      args: { argument: [{ name: 'Textures', kind: 'separator' }], options: { place: { kind: 'modOrder' }, end: 'winning' } },
      command: 'modbench.mod.move',
      argument: [separator('Textures')],
      options: { place: { kind: 'modOrder' }, end: 'winning' },
    },
    {
      name: 'mod_uninstall carries the mods named',
      value: CONFLICTED,
      tool: 'mod_uninstall',
      args: { argument: [{ name: 'B' }, { name: 'C' }] },
      command: 'modbench.mod.uninstall',
      argument: [mod('B'), mod('C')],
      options: {},
    },
    {
      name: 'mod_uninstall carries force as an Option',
      value: CONFLICTED,
      tool: 'mod_uninstall',
      args: { argument: [{ name: 'B' }], options: { force: true } },
      command: 'modbench.mod.uninstall',
      argument: [mod('B')],
      options: { force: true },
    },
    {
      name: 'separator_delete carries force as an Option',
      value: CONFLICTED,
      tool: 'separator_delete',
      args: { argument: [{ name: 'Textures' }], options: { force: true } },
      command: 'modbench.separator.delete',
      argument: [separator('Textures')],
      options: { force: true },
    },
    {
      name: 'mod_rename carries the one mod as its Argument and the new name as an Option',
      value: CONFLICTED,
      tool: 'mod_rename',
      args: { argument: [{ name: 'B' }], options: { name: 'Bee' } },
      command: 'modbench.mod.rename',
      argument: [mod('B')],
      options: { name: 'Bee' },
    },
    {
      name: 'mod_create_empty carries the name as an Option and no Argument',
      value: CONFLICTED,
      tool: 'mod_create_empty',
      args: { options: { name: 'New' } },
      command: 'modbench.mod.createEmpty',
      argument: [],
      options: { name: 'New' },
    },
    {
      name: 'mod_exclude_file carries each file by its path in its mod, in the mod\'s own casing',
      value: CONFLICTED,
      tool: 'mod_exclude_file',
      args: { argument: [{ mod: { name: 'C' }, path: 'meshes/X.NIF' }, { mod: { name: 'B' }, path: 'textures/rock.dds' }] },
      command: 'modbench.mod.excludeFile',
      argument: [
        { kind: 'file', origin: mod('C'), relativePath: 'MESHES/x.nif' },
        { kind: 'file', origin: mod('B'), relativePath: 'Textures/Rock.DDS' },
      ],
      options: {},
    },
    {
      name: 'mod_include_file carries each file by its path in its mod, in the mod\'s own casing',
      value: CONFLICTED,
      tool: 'mod_include_file',
      args: { argument: [{ mod: { name: 'C' }, path: 'meshes/X.NIF' }, { mod: { name: 'B' }, path: 'textures/rock.dds' }] },
      command: 'modbench.mod.includeFile',
      argument: [
        { kind: 'file', origin: mod('C'), relativePath: 'MESHES/x.nif' },
        { kind: 'file', origin: mod('B'), relativePath: 'Textures/Rock.DDS' },
      ],
      options: {},
    },
    {
      name: 'mod_include_file carries an excluded file as the mod has it on disk, named by its own path',
      value: instanceValueFixture({
        mods: [{ kind: 'mod', name: 'B', enabled: true }],
        filesByMod: new Map([['B', [fileIn('/m', 'F4SE/Plugins/BetterConsole.mem.mohidden')]]]),
      }),
      tool: 'mod_include_file',
      args: { argument: [{ mod: { name: 'B' }, path: 'F4SE/Plugins/BetterConsole.mem' }] },
      command: 'modbench.mod.includeFile',
      argument: [{ kind: 'file', origin: mod('B'), relativePath: 'F4SE/Plugins/BetterConsole.mem.mohidden' }],
      options: {},
    },
    {
      name: 'mod_exclude_file carries a file of Overwrite, which list_mods names as a runtimeOutput, by its path there',
      value: instanceValueFixture({ overwriteFiles: [fileIn('/o', 'Sub/ow.txt')] }),
      tool: 'mod_exclude_file',
      args: { argument: [{ mod: { name: 'Overwrite', kind: 'runtimeOutput' }, path: 'sub/OW.txt' }] },
      command: 'modbench.mod.excludeFile',
      argument: [{ kind: 'file', origin: { kind: 'runtimeOutput' }, relativePath: 'Sub/ow.txt' }],
      options: {},
    },
    {
      name: 'mod_exclude_file carries a file of Overwrite named as list_mods names it, with no kind',
      value: instanceValueFixture({ overwriteFiles: [fileIn('/o', 'Sub/ow.txt')] }),
      tool: 'mod_exclude_file',
      args: { argument: [{ mod: { name: 'Overwrite' }, path: 'Sub/ow.txt' }] },
      command: 'modbench.mod.excludeFile',
      argument: [{ kind: 'file', origin: { kind: 'runtimeOutput' }, relativePath: 'Sub/ow.txt' }],
      options: {},
    },
    {
      name: 'mod_add_publisher_tag carries a folder the mod manager excludes as the mod has it on disk, named by its own path',
      value: instanceValueFixture({
        mods: [{ kind: 'mod', name: 'B', enabled: true }],
        foldersByMod: new Map([['B', [{ relativePath: 'Textures.mohidden', path: '/m/Textures.mohidden', includedPath: 'Textures', excluded: true }]]]),
      }),
      tool: 'mod_add_publisher_tag',
      args: { argument: [{ mod: { name: 'B' }, path: 'Textures' }], options: { tag: 'Patched' } },
      command: 'modbench.mod.addPublisherTag',
      argument: [{ kind: 'file', origin: mod('B'), relativePath: 'Textures.mohidden' }],
      options: { tag: 'Patched' },
    },
    ...(['add', 'remove'] as const).map((direction): GestureCase => ({
      name: `mod_${direction}_publisher_tag carries each mod, or each file or folder by its path in its mod in the mod's own casing, and the tag as an Option`,
      value: { ...CONFLICTED, foldersByMod: new Map([['B', [{ relativePath: 'Textures', path: '/m/Textures', includedPath: 'Textures', excluded: false }]]]) },
      tool: `mod_${direction}_publisher_tag`,
      args: { argument: [{ mod: { name: 'C' } }, { mod: { name: 'B' }, path: 'textures' }, { mod: { name: 'C' }, path: 'meshes/X.NIF' }], options: { tag: 'Include' } },
      command: `modbench.mod.${direction}PublisherTag`,
      argument: [
        mod('C'),
        { kind: 'file', origin: mod('B'), relativePath: 'Textures' },
        { kind: 'file', origin: mod('C'), relativePath: 'MESHES/x.nif' },
      ],
      options: { tag: 'Include' },
    })),
    {
      name: 'modlist_git_init carries nothing',
      value: CONFLICTED,
      tool: 'modlist_git_init',
      args: {},
      command: 'modbench.modlist.gitInit',
      argument: [],
      options: {},
    },
    {
      name: 'mod_update_manifest carries the mods and separators named',
      value: CONFLICTED,
      tool: 'mod_update_manifest',
      args: { argument: [{ name: 'B' }, { name: 'Textures', kind: 'separator' }] },
      command: 'modbench.mod.updateManifest',
      argument: [mod('B'), separator('Textures')],
      options: {},
    },
    {
      name: 'mod_update_manifest carries no Argument for every mod',
      value: CONFLICTED,
      tool: 'mod_update_manifest',
      args: {},
      command: 'modbench.mod.updateManifest',
      argument: [],
      options: {},
    },
    {
      name: 'mod_build carries the mods named',
      value: CONFLICTED,
      tool: 'mod_build',
      args: { argument: [{ name: 'B' }] },
      command: 'modbench.mod.build',
      argument: [mod('B')],
      options: {},
    },
    {
      name: 'mod_build carries no Argument for every source in the source folder',
      value: CONFLICTED,
      tool: 'mod_build',
      args: {},
      command: 'modbench.mod.build',
      argument: [],
      options: {},
    },
    {
      name: 'mod_restore_from_manifest carries the mods and separators named',
      value: CONFLICTED,
      tool: 'mod_restore_from_manifest',
      args: { argument: [{ name: 'B' }, { name: 'Textures', kind: 'separator' }] },
      command: 'modbench.mod.restoreFromManifest',
      argument: [mod('B'), separator('Textures')],
      options: {},
    },
    {
      name: 'mod_restore_from_manifest carries no Argument for every mod',
      value: CONFLICTED,
      tool: 'mod_restore_from_manifest',
      args: {},
      command: 'modbench.mod.restoreFromManifest',
      argument: [],
      options: {},
    },
    {
      name: 'downloaded_file_exclude carries the downloaded files named',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'downloaded_file_exclude',
      args: { argument: [{ name: 'rocks.7z' }] },
      command: 'modbench.downloadedFile.exclude',
      argument: [rocks],
      options: {},
    },
    {
      name: 'downloaded_file_include carries the downloaded files named',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'downloaded_file_include',
      args: { argument: [{ name: 'rocks.7z' }] },
      command: 'modbench.downloadedFile.include',
      argument: [rocks],
      options: {},
    },
    {
      name: 'downloaded_file_delete carries the downloaded files named',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'downloaded_file_delete',
      args: { argument: [{ name: 'rocks.7z' }] },
      command: 'modbench.downloadedFile.delete',
      argument: [rocks],
      options: {},
    },
    {
      name: 'mod_install takes a downloaded file as the source',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'mod_install',
      args: { argument: [rocks], options: { name: 'New' } },
      command: 'modbench.mod.install',
      argument: [rocks],
      options: { name: 'New' },
    },
    {
      name: 'mod_install takes an installation file outside the downloaded files as the source',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'mod_install',
      args: { argument: [outside], options: { name: 'New' } },
      command: 'modbench.mod.install',
      argument: [outside],
      options: { name: 'New' },
    },
    {
      name: 'mod_install takes a folder outside the downloads as the source',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'mod_install',
      args: { argument: [{ kind: 'folder', path: '/elsewhere/a' }], options: { name: 'New' } },
      command: 'modbench.mod.install',
      argument: [{ kind: 'folder', path: '/elsewhere/a' }],
      options: { name: 'New' },
    },
    {
      name: 'mod_install carries the target mod named as list_mods names it, to upgrade it',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'mod_install',
      args: { argument: [outside], options: { target: 'B' } },
      command: 'modbench.mod.install',
      argument: [outside],
      options: { target: 'B' },
    },
    {
      name: 'mod_install carries no Options when the call leaves out options, for the command to refuse naming them',
      value: CONFLICTED_WITH_DOWNLOADED_FILES,
      tool: 'mod_install',
      args: { argument: [outside] },
      command: 'modbench.mod.install',
      argument: [outside],
      options: {},
    },
  ];

  it.each(GESTURES)('$name', async ({ value, tool, args, command, argument, options }) => {
    fired.outcome = { applied: true, outcome: { landed: [], refused: [] } };
    const { client } = await served(value);

    await call(client, tool, args);

    expect(fired.calls).toEqual([[command, new AgentCall(argument, options)]]);
  });

  describe('a file the mod manager marks excluded', () => {
    const marked = instanceValueFixture({
      mods: [{ kind: 'mod', name: 'B', enabled: true }],
      filesByMod: new Map([['B', [fileIn('/m', 'Textures/a.dds.mohidden')]]]),
    });
    const ref = (relativePath: string) => ({ origin: mod('B'), relativePath });
    const OWN = JSON.stringify(ref('Textures/a.dds'));

    it.each([
      ['landed', { landed: [ref('Textures/a.dds.mohidden')], refused: [] }, `{"landed":[${OWN}],"refused":[]}`],
      ['refused', { landed: [], refused: [{ item: ref('Textures/a.dds.mohidden'), reason: 'gone' }] }, `{"landed":[],"refused":[{"item":${OWN},"reason":"gone"}]}`],
    ])('is answered by its own path when %s', async (_state, outcome, text) => {
      fired.outcome = { applied: true, outcome };
      const { client } = await served(marked);

      const answer = await call(client, 'mod_include_file', { argument: [{ mod: { name: 'B' }, path: 'Textures/a.dds' }] });

      expect(answer.text).toBe(text);
    });
  });

  describe('the plugin gestures', () => {
    it('refuses a file name two plugins share, listing both, and a plugin nothing holds', async () => {
      const { client } = await served(PLUGGED);

      const answer = await call(client, 'plugin_decompile', { argument: [{ name: 'Same.esp' }, { name: 'Gone.esp' }] });

      expect(answer.text).toContain('"Same.esp" means more than one plugin: Same.esp in ModA; Same.esp in ModB. Name it with its origin.');
      expect(answer.text).toContain('No plugin is named "Gone.esp".');
      expect(fired.calls).toEqual([]);
    });

    it.each([
      ['plugin_enable', { argument: [{ name: 'Same.esp', origin: 'ModB' }] }],
      ['plugin_disable', { argument: [{ name: 'Same.esp', origin: 'ModB' }] }],
      ['plugin_move', { argument: [{ name: 'Same.esp', origin: 'ModB' }], options: { drop: { kind: 'winningEnd' } } }],
      ['plugin_rename', { argument: { name: 'Same.esp', origin: 'ModB' }, options: { name: 'Other.esp' } }],
    ])('refuses %s on an overridden copy, naming the copy its line belongs to, firing nothing', async (tool, args) => {
      const { client, lines } = await served(PLUGGED);

      const answer = await call(client, tool, args);

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('Same.esp in ModB is overridden, and the line for "Same.esp" is Same.esp in ModA\'s. Name that one.');
      expect(lines.join('\n')).toContain('Same.esp in ModB is overridden');
      expect(fired.calls).toEqual([]);
    });

    it('logs a refusal with its detail joined on', async () => {
      fired.outcome = { applied: false, refusal: 'Could not move plugins.', detail: 'A.esp is a master.' };
      const { client, lines } = await served(PLUGGED);

      const answer = await call(client, 'plugin_decompile', { argument: [{ name: 'Solo.esp' }] });

      expect(answer).toEqual({ isError: true, text: JSON.stringify({ refusal: 'Could not move plugins.', detail: 'A.esp is a master.' }) });
      expect(lines.join('\n')).toContain('Could not move plugins. A.esp is a master.');
    });

    it('refuses a load after that names an origin, which LOOT does not key a rule by, firing nothing', async () => {
      const { client } = await served(PLUGGED);

      const answer = await call(client, 'plugin_load_after', { argument: [{ name: 'Solo.esp' }], options: { after: [{ name: 'Same.esp', origin: 'ModA' }] } });

      expect(answer.isError).toBe(true);
      expect(fired.calls).toEqual([]);
    });

    it('refuses a create that leaves out its argument, naming it', async () => {
      const { client } = await served(PLUGGED);

      const answer = await call(client, 'plugin_create', { options: { name: 'New.esp' } });

      expect(answer.text).toContain('argument');
      expect(fired.calls).toEqual([]);
    });
  });

  describe('the separator gestures', () => {
    it('refuses a name that is a mod, not a separator, firing nothing', async () => {
      const answer = await fire('separator_delete', { argument: [{ name: 'B' }] });

      expect(answer.text).toContain('Nothing is named "B" as a separator.');
      expect(fired.calls).toEqual([]);
    });
  });

  describe('the mod gestures', () => {
    it('refuses a place nothing is named, firing nothing', async () => {
      const answer = await fire('mod_move', { argument: [{ name: 'B' }], options: { place: { kind: 'mod', name: 'Gone' }, end: 'winning' } });

      expect(answer.text).toContain('Nothing is named "Gone" as a mod.');
      expect(fired.calls).toEqual([]);
    });

    it('logs the parts of a landed gesture that failed in the Output, and answers it as landed', async () => {
      fired.outcome = { applied: true, outcome: { landed: ['Bee'], refused: [] }, partial: [{ message: '"B" was renamed, but a line could not be renamed.', detail: 'disk full', severity: 'warning' }] };
      const { client, lines } = await served();

      const answer = await call(client, 'mod_rename', { argument: [{ name: 'B' }], options: { name: 'Bee' } });

      expect(answer.isError).toBe(false);
      expect(lines.join('\n')).toContain('"B" was renamed, but a line could not be renamed. disk full');
    });

    it('refuses a move that leaves out its place, naming it', async () => {
      const answer = await fire('mod_move', { argument: [{ name: 'B' }], options: { end: 'losing' } });

      expect(answer.text).toContain('place');
      expect(fired.calls).toEqual([]);
    });

  });

  describe('the downloaded file gestures and install', () => {
    it('refuses a downloaded file nothing is named, firing nothing', async () => {
      const answer = await fire('downloaded_file_delete', { argument: [{ name: 'gone.7z' }] }, CONFLICTED_WITH_DOWNLOADED_FILES);

      expect(answer.text).toContain('Nothing is named "gone.7z" among the downloaded files.');
      expect(fired.calls).toEqual([]);
    });

    it('refuses an install over a mod nothing is named, firing nothing', async () => {
      const answer = await fire('mod_install', { argument: [outside], options: { target: 'Gone' } }, CONFLICTED_WITH_DOWNLOADED_FILES);

      expect(answer.text).toContain('Nothing is named "Gone" as a mod.');
      expect(fired.calls).toEqual([]);
    });
  });

  describe('the record open gesture', () => {
    const gun = { kind: 'record' as const, formKey: '000801:A.esp' };
    const open = async (args: Record<string, unknown>, answer: Awaited<ReturnType<MEditClient['resolveNames']>>) => {
      fired.outcome = { applied: true, outcome: { landed: [], refused: [] } };
      const mEdit = new InMemoryMEditClient();
      mEdit.setQueryAnswer('resolveNames', answer);
      const { client } = await clientOf(new FakeInstance({ ...CONFLICTED, plugins: VALUE.plugins }), mEdit);
      return { mEdit, answer: await call(client, 'record_open', args) };
    };

    it('resolves each record by EditorID or FormKey through mEdit, and fires the FormKeys as record Arguments with the pinned Option', async () => {
      const { mEdit } = await open(
        { argument: [{ name: 'Gun' }, { name: '000802:A.esp' }], options: { pinned: true } },
        [{ formKey: '000801:A.esp', editorId: 'Gun' }, { formKey: '000802:A.esp' }]);

      expect(mEdit.calls).toContainEqual({ method: 'resolveNames', args: [[{ name: 'Gun' }, { name: '000802:A.esp' }]] });
      expect(fired.calls).toEqual([['modbench.record.open', new AgentCall([gun, { kind: 'record', formKey: '000802:A.esp' }], { pinned: true })]]);
    });

    it('fires a copy when the record names its plugin, as list_plugins shows it', async () => {
      const { name, origin } = VALUE.plugins[1] ?? { name: '', origin: '' };
      await open({ argument: [{ name: 'Gun', plugin: { name, origin } }] }, [{ formKey: '000801:A.esp' }]);

      expect(fired.calls).toEqual([['modbench.record.open', new AgentCall([{ ...gun, plugin: { name, origin } }], { pinned: undefined })]]);
    });

    it('names a plugin the game loads with no line as list_plugins shows it', async () => {
      fired.outcome = { applied: true, outcome: { landed: [], refused: [] } };
      const mEdit = new InMemoryMEditClient();
      mEdit.setQueryAnswer('resolveNames', [{ formKey: '000801:Fallout4.esm', editorId: 'Gun' }]);
      const noLine = { name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN, path: '/game/Data/Fallout4.esm' };
      const { client } = await clientOf(new FakeInstance({ ...VALUE, pluginsLoadedWithNoLine: [noLine] }), mEdit);

      await call(client, 'record_open', { argument: [{ name: 'Gun', plugin: { name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN } }] });

      expect(fired.calls).toEqual([['modbench.record.open', new AgentCall([{ kind: 'record', formKey: '000801:Fallout4.esm', plugin: { name: 'Fallout4.esm', origin: DATA_DIRECTORY_ORIGIN } }], { pinned: undefined })]]);
    });

    it('names a plugin the game loads with no line that a mod provides, one plugin though both lists hold it', async () => {
      fired.outcome = { applied: true, outcome: { landed: [], refused: [] } };
      const mEdit = new InMemoryMEditClient();
      mEdit.setQueryAnswer('resolveNames', [{ formKey: '000801:Cc.esl', editorId: 'Gun' }]);
      const cc = { name: 'Cc.esl', origin: 'Big Rocks', path: '/m/Cc.esl', line: null, enabled: true, winning: true };
      const { client } = await clientOf(new FakeInstance({ ...VALUE, plugins: [...VALUE.plugins, cc], pluginsLoadedWithNoLine: [cc] }), mEdit);

      await call(client, 'record_open', { argument: [{ name: 'Gun', plugin: { name: 'Cc.esl' } }] });

      expect(fired.calls).toEqual([['modbench.record.open', new AgentCall([{ kind: 'record', formKey: '000801:Cc.esl', plugin: { name: 'Cc.esl', origin: 'Big Rocks' } }], { pinned: undefined })]]);
    });

    it('refuses with mEdit\'s listing of the matches a name means, firing nothing', async () => {
      const listing = '"Gun" means more than one thing: record 000801:A.esp (Gun); record 000802:B.esp (Gun).';
      const { answer } = await open({ argument: [{ name: 'Gun' }] }, { failed: 'refused', refusal: listing });

      expect(answer).toEqual({ isError: true, text: listing });
      expect(fired.calls).toEqual([]);
    });

    it('refuses a name that is a plugin, not a record, firing nothing', async () => {
      const { answer } = await open({ argument: [{ name: 'A.esp' }] }, [{ plugin: { name: 'A.esp', origin: 'Big Rocks' } }]);

      expect(answer.text).toContain('"A.esp" is not a record.');
      expect(fired.calls).toEqual([]);
    });

    it('refuses a plugin nothing is named, firing nothing', async () => {
      const { answer } = await open({ argument: [{ name: 'Gun', plugin: { name: 'Gone.esp' } }] }, [{ formKey: '000801:A.esp' }]);

      expect(answer.text).toContain('No plugin is named "Gone.esp".');
      expect(fired.calls).toEqual([]);
    });
  });

  it.each([
    ['a name that means a mod and a separator', { argument: [{ name: 'Textures' }] }, '"Textures" means more than one thing: separator Textures; mod Textures. Name it with its kind.'],
    ['a separator', { argument: [{ name: 'Textures', kind: 'separator' }] }, '"Textures" is a separator, not a mod.'],
    ['no Argument', {}, 'argument'],
  ])('refuses %s, firing nothing', async (_case, args, refusal) => {
    const { client, lines } = await served();

    const answer = await call(client, 'mod_enable', args);

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(refusal);
    expect(lines.join('\n')).toContain(refusal);
    expect(fired.calls).toEqual([]);
  });
});

describe('the agent server, given an input its tool does not take', () => {
  it.each([
    ['list_file_conflicts', { mods: 'A' }, 'mods'],
    ['resolve_instance_names', { downloads: 'rocks.7z' }, 'downloads'],
    ['resolve_names', {}, 'names'],
    ['select_rows', { sql: 5 }, 'sql'],
    ['mod_enable', { argument: '[{"name":"A"}]' }, 'argument'],
  ])('%s refuses it, naming the input, in the Output and in no notification', async (name, args, input) => {
    const { client, lines, reporter } = await clientOf(new FakeInstance(CONFLICTED_WITH_DOWNLOADED_FILES));

    const refusal = await call(client, name, args);

    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain(input);
    expect(lines).toEqual([`[agent] ${name}: ${refusal.text}`]);
    expect(reporter.reports).toEqual([]);
  });

  it('tells the agent select_rows reads only the views, and where their columns are listed', async () => {
    const { tools } = await (await clientOf(new FakeInstance(VALUE))).client.listTools();

    const description = tools.find((tool) => tool.name === 'select_rows')?.description;
    expect(description).toContain('only the views');
    expect(description).toContain('is_active');
    expect(description).toContain('view_columns');
  });

  it('advertises the SQL select_rows takes as a required string', async () => {
    const { tools } = await (await clientOf(new FakeInstance(VALUE))).client.listTools();

    expect(tools.find((tool) => tool.name === 'select_rows')?.inputSchema).toMatchObject({ properties: { sql: { type: 'string' } }, required: ['sql'] });
  });
});

describe('the agent server, given no instance', () => {
  it('takes no port', async () => {
    const { address, reporter } = await serve(undefined, await takenPort());

    expect(address).toBeUndefined();
    expect(reporter.reports).toEqual([]);
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
    const taken = await takenPort();

    const { bound, reporter } = await serve(new FakeInstance(VALUE), taken);

    expect(bound).toBeUndefined();
    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0]?.severity).toBe('error');
    expect(reporter.reports[0]?.message).toContain(PORT_SETTING);
    expect(reporter.reports[0]?.message).toContain(String(taken));
  });
});
