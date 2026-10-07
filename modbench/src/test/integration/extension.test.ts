import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { before, after, afterEach, describe, it } from 'mocha';
import type { CompareResult, PluginMetadata, PluginProblems } from '../../client';
import { present } from '../../ports/present';
import { comparisonOf, fieldOf } from '../comparison';
import { isRecord, requires } from '../manifest';

const MANIFEST: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

function contributed(point: string): unknown[] {
  const entries = isRecord(MANIFEST) && isRecord(MANIFEST.contributes) ? MANIFEST.contributes[point] : undefined;
  if (!Array.isArray(entries)) throw new Error(`expected package.json to contribute a ${point} array`);
  return entries;
}

function extensionId(): string {
  if (!isRecord(MANIFEST) || typeof MANIFEST.publisher !== 'string' || typeof MANIFEST.name !== 'string') {
    throw new Error('expected package.json to name its publisher and name');
  }
  return `${MANIFEST.publisher}.${MANIFEST.name}`;
}
const EXTENSION_ID = extensionId();

function copyValueKeyArgs(view: string): unknown {
  const key = contributed('keybindings').find((k) =>
    isRecord(k) && k.command === 'modbench.copyValue' && typeof k.when === 'string' && requires(k.when, `focusedView == ${view}`));
  if (!isRecord(key)) throw new Error(`expected package.json to bind Copy Value in ${view}`);
  return key.args;
}

const TEST_PORT = Number(present(process.env.MODBENCH_TEST_PORT, 'the port .vscode-test.mjs hands the run'));
const LOGS = present(process.env.MODBENCH_TEST_LOGS, 'the logs folder .vscode-test.mjs hands the run');
const root = present(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, 'the workspace folder');
const pluginsTxtPath = path.join(root, 'profiles', 'Default', 'plugins.txt');
const modlistPath = path.join(root, 'profiles', 'Default', 'modlist.txt');
function fixtureGameDirectory(): string {
  const dir = vscode.workspace.getConfiguration('modbench').get<string>('mods.gameDirectory') ?? '';
  if (dir === '') throw new Error('expected .vscode-test.mjs to name a game folder, so that no test reads this machine\'s own install');
  return dir;
}
const FIXTURE_GAME_DIRECTORY = fixtureGameDirectory();
let mockBackend: http.Server;

async function setGameDirectory(dir: string): Promise<void> {
  await vscode.workspace.getConfiguration('modbench').update(
    'mods.gameDirectory', dir, vscode.ConfigurationTarget.Workspace);
}

function gameFolderHolding(prefix: string, plugins: readonly string[]): string {
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
  for (const name of plugins) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
  return gameDir;
}

async function holdPluginsTxt(text: string): Promise<void> {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^\*/, '')).filter((line) => line !== '');
  await waitFor(`mEdit to be put the load order of a plugins.txt holding ${lines.join(', ')}, rewritten past a sync of an earlier value`, () => {
    if (fs.readFileSync(pluginsTxtPath, 'utf8') !== text) fs.writeFileSync(pluginsTxtPath, text);
    const put = putLoadOrders.at(-1) ?? [];
    return put.filter((name) => lines.includes(name)).join() === lines.join() && fs.readFileSync(pluginsTxtPath, 'utf8') === text;
  });
}

type MockPlugin = PluginMetadata;
function mockPlugin(over: Partial<PluginMetadata> & Pick<PluginMetadata, 'name' | 'path' | 'origin' | 'inLoadOrder'>): MockPlugin {
  return {
    isLight: false, isMaster: false, isBlueprint: false, masters: [], recordCount: 0, isImmutable: false,
    masterIssues: [], hasMatchingRecords: true,
    isTracked: false,
    hasParseFailure: false,
    pluginSourceUnreadable: false,
    ...over,
  };
}
const TRACKED_PLUGIN = 'Tracked.esp';
const TRACKED_ORIGIN = 'TrackedMod';
const MOCK_PLUGINS: MockPlugin[] = [
  mockPlugin({ name: 'Fallout4.esm', path: '/data/Fallout4.esm', origin: 'Data', inLoadOrder: true }),
  mockPlugin({ name: 'TestMod.esp', path: '/data/TestMod.esp', origin: 'Data', inLoadOrder: true }),
  mockPlugin({ name: 'Other.esp', path: '/data/Other.esp', origin: 'Data', inLoadOrder: false }),
  mockPlugin({ name: 'Second.esp', path: '/data/Second.esp', origin: 'Data', inLoadOrder: true }),
  mockPlugin({ name: TRACKED_PLUGIN, path: `/mods/${TRACKED_ORIGIN}/${TRACKED_PLUGIN}`, origin: TRACKED_ORIGIN, inLoadOrder: true, isTracked: true }),
];
const MOCK_RECORD_TYPES = [{ type: 'weap', count: 3, displayName: 'Weapon' }];
let loadOrderHeld = false;
const requestLog: string[] = [];
const putLoadOrders: string[][] = [];
const comparedTexts: unknown[] = [];
const comparedSideBySide: unknown[] = [];

function documentTextOf(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === 'object' && parsed !== null && 'documentText' in parsed ? parsed.documentText : undefined;
}

interface EditAsked { value: unknown; text: string }
function editAskedOf(body: string): EditAsked {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || !isRecord(parsed.edit) || typeof parsed.text !== 'string') throw new Error(`expected an edit and a text, got: ${body}`);
  return { value: parsed.edit.value, text: parsed.text };
}
const editsAsked: EditAsked[] = [];
const carriedIn = new Map<string, string>();
const heldIn = new Map<string, string>();
type EditAnswer = { status: number; body: unknown };
const refusedAsUntracked: EditAnswer = { status: 409, body: { refusal: 'PluginNotTracked', detail: 'Tracked.esp is not tracked, so it is read-only.' } };
let answerEdit: (asked: EditAsked) => EditAnswer = () => refusedAsUntracked;

function pluginNamesOf(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  const plugins = typeof parsed === 'object' && parsed !== null && 'plugins' in parsed ? parsed.plugins : undefined;
  if (!Array.isArray(plugins)) throw new Error(`expected a PUT /load-order body with a plugins array, got: ${body}`);
  return plugins.map((p: unknown) => (typeof p === 'object' && p !== null && 'name' in p ? String(p.name) : '?'));
}
let rebuildIndexShouldFail = false;
const RAW_INDEX_LOCKED_DETAIL = 'raw backend detail: index lock held by pid 4242';
type MockLoadOrderStatus = {
  state: 'None' | 'Reconciling' | 'Ready' | 'HeldElsewhere' | 'Failed';
  totalPlugins: number;
  activePlugins: number;
  indexedPlugins: { name: string; origin: string }[];
  conflictsComputed: boolean;
  failures: { name: string; origin: string; reason: string }[];
  version: number;
  message?: string;
};
let loadOrderStatus: MockLoadOrderStatus =
  { state: 'None', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], version: 0 };
let loadOrderVersion = 0;

const sseClients: http.ServerResponse[] = [];
let pluginProblems: PluginProblems[] = [];

function writeSseFrame(res: http.ServerResponse, kind: string, payload: Record<string, unknown>): void {
  const data = JSON.stringify({ kind, plugin: '', origin: '', keys: [], sequence: 0, ...payload });
  res.write(`event: ${kind}\ndata: ${data}\n\n`);
}

function pushLoadOrderStatus(): void {
  for (const res of sseClients) writeSseFrame(res, 'load-order-status', { loadOrderStatus });
}

function createMockBackend(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    requestLog.push(`${method} ${url}`);
    if (url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (method === 'POST' && url === '/index/rebuild') {
      req.on('data', () => {});
      req.on('end', () => {
        if (rebuildIndexShouldFail) {
          res.writeHead(423, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: RAW_INDEX_LOCKED_DETAIL }));
          return;
        }
        res.writeHead(204);
        res.end();
        if (!loadOrderHeld) return;
        const held = loadOrderStatus;
        for (const state of ['None', 'Reconciling'] as const) {
          loadOrderStatus = { ...held, state, indexedPlugins: [], conflictsComputed: false };
          pushLoadOrderStatus();
        }
        loadOrderStatus = { ...held, state: 'Ready', conflictsComputed: true };
        pushLoadOrderStatus();
      });
      return;
    }
    if (method === 'PUT' && url === '/load-order') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        putLoadOrders.push(pluginNamesOf(body));
        loadOrderVersion += 1;
        const version = loadOrderVersion;
        loadOrderStatus = { ...loadOrderStatus, version };
        pushLoadOrderStatus();
        loadOrderHeld = true;
        loadOrderStatus = { ...loadOrderStatus, state: 'Ready', conflictsComputed: true, version };
        pushLoadOrderStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ applied: true, version }));
      });
      return;
    }
    if (url === '/load-order/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadOrderStatus));
      return;
    }
    if (url === '/load-order/filter') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sql: null }));
      return;
    }
    if (url === '/notifications/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      sseClients.push(res);
      req.on('close', () => {
        const i = sseClients.indexOf(res);
        if (i >= 0) sseClients.splice(i, 1);
      });
      return;
    }
    if (url === '/plugins/creatable-extensions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(['.esp', '.esm', '.esl']));
      return;
    }
    if (method === 'POST' && url === '/plugins/create') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const asked: unknown = JSON.parse(body);
        if (!isRecord(asked) || typeof asked.name !== 'string' || typeof asked.origin !== 'string' || typeof asked.folder !== 'string') {
          throw new Error(`expected a create body naming a plugin, its origin and its folder, got: ${body}`);
        }
        fs.writeFileSync(path.join(asked.folder, asked.name), '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: asked.name, origin: asked.origin }));
      });
      return;
    }
    if (url === '/plugins/problems') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pluginProblems));
      return;
    }
    if (url === '/plugins') {
      if (!loadOrderHeld) {
        res.writeHead(503);
        res.end('No load order has been received.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(MOCK_PLUGINS));
      return;
    }
    if (/^\/plugins\/[^/?]+\/record-types(\?|$)/.test(url)) {
      res.writeHead(loadOrderHeld ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(loadOrderHeld ? JSON.stringify(MOCK_RECORD_TYPES) : 'No load order has been received.');
      return;
    }
    const copyFile = /^\/plugins\/([^/?]+)\/records\/([^/?]+)\/file\?/.exec(url);
    if (copyFile) {
      const [, plugin = '', formKey = ''] = copyFile;
      const tracked = decodeURIComponent(plugin) === TRACKED_PLUGIN && new URL(url, 'http://x').searchParams.get('origin') === TRACKED_ORIGIN;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: tracked ? carriedIn.get(decodeURIComponent(formKey)) ?? TRACKED_FILE : null }));
      return;
    }
    const rendered = /^\/plugins\/[^/?]+\/records\/([^/?]+)\/rendered-document\?/.exec(url)?.[1];
    if (rendered !== undefined) {
      const formKey = decodeURIComponent(rendered);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(formKey === UNTRACKED_FORM_KEY
        ? { fileName: UNTRACKED_FILE_NAME, text: untrackedText }
        : { fileName: renderedName(formKey), text: renderedText(formKey) }));
      return;
    }
    if (url.startsWith('/plugin-source/record?')) {
      const filePath = new URL(url, 'http://x').searchParams.get('path');
      const fsPath = filePath === null ? undefined : vscode.Uri.file(filePath).fsPath;
      const holds = fsPath === TRACKED_FS_PATH ? TRACKED_FORM_KEY : fsPath && heldIn.get(fsPath);
      res.writeHead(holds ? 200 : 422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(holds
        ? { formKey: holds, plugin: TRACKED_PLUGIN, origin: TRACKED_ORIGIN }
        : { detail: `${filePath} declares no FormKey, so it is no record's document.` }));
      return;
    }
    if (method === 'POST' && url === '/records/compare') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed: unknown = JSON.parse(body);
        const copies = typeof parsed === 'object' && parsed !== null && 'copies' in parsed && Array.isArray(parsed.copies) ? parsed.copies : [];
        comparedSideBySide.push(copies);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(comparisonOf('Fallout4.esm:000001', [{ plugin: 'Fallout4.esm', isWinner: true }])));
      });
      return;
    }
    if (method === 'POST' && /^\/records\/[^/?]+\/edit-changes$/.test(url)) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const asked = editAskedOf(body);
        editsAsked.push(asked);
        const { status, body: answer } = answerEdit(asked);
        res.writeHead(status, { 'Content-Type': status === 200 ? 'application/json' : 'application/problem+json' });
        res.end(JSON.stringify(answer));
      });
      return;
    }
    const wonFormKey = /^\/records\/([^/?]+)$/.exec(url)?.[1];
    if (wonFormKey !== undefined && decodeURIComponent(wonFormKey) === NOT_HELD_FORM_KEY) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (wonFormKey !== undefined) {
      const winner = [TRACKED_FORM_KEY, CHILD_FORM_KEY].includes(decodeURIComponent(wonFormKey))
        ? { plugin: TRACKED_PLUGIN, origin: TRACKED_ORIGIN } : { plugin: 'Fallout4.esm', origin: 'Data' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ formKey: decodeURIComponent(wonFormKey), ...winner }));
      return;
    }
    const comparedFormKey = /^\/records\/([^/?]+)\/compare$/.exec(url)?.[1];
    if (comparedFormKey !== undefined) {
      const answer = MOCK_COMPARISONS.get(decodeURIComponent(comparedFormKey));
      const respond = () => {
        res.writeHead(answer ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(answer ? JSON.stringify(answer) : undefined);
      };
      if (method !== 'POST') {
        respond();
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        comparedTexts.push(documentTextOf(body));
        respond();
      });
      return;
    }
    const referenced = /^\/records\/([^/?]+)\/references$/.exec(url)?.[1];
    if (referenced !== undefined) {
      const row = (formKey: string, plugin: string, origin: string, fieldPath: string) =>
        ({ formKey, plugin, origin, fieldPath, recordType: 'WEAP', recordTypeName: 'Weapon' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(decodeURIComponent(referenced) === HELD_FORM_KEY ? [
        row(TRACKED_FORM_KEY, TRACKED_PLUGIN, TRACKED_ORIGIN, 'Model'), row(TRACKED_FORM_KEY, TRACKED_PLUGIN, TRACKED_ORIGIN, 'Template'),
        row(CHILD_FORM_KEY, TRACKED_PLUGIN, TRACKED_ORIGIN, 'Base'), row(RENDERED_REFERRER_FORM_KEY, 'Fallout4.esm', 'Data', 'Base'),
        row(HELD_FORM_KEY, 'Fallout4.esm', 'Data', 'Template'),
      ] : []));
      return;
    }
    if (url.startsWith('/records?') && new URL(url, 'http://x').searchParams.get('plugin') === TRACKED_PLUGIN) {
      const summary = (formKey: string, editorId: string) => ({ formKey, plugin: TRACKED_PLUGIN, loadOrderIndex: 4, isWinner: true, editorId,
        origin: TRACKED_ORIGIN, workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false });
      const items = [summary(TRACKED_FORM_KEY, 'TrackedGun'), summary(CHILD_FORM_KEY, 'TrackedRef')];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total: items.length }));
      return;
    }
    if (url.startsWith('/records?') && new URL(url, 'http://x').searchParams.has('search')) {
      const items = [{ formKey: HELD_FORM_KEY, plugin: 'Patch.esp', loadOrderIndex: 1, isWinner: true, editorId: 'NewGun', origin: 'Data',
        workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false }];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, total: items.length }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

const TRACKED_FORM_KEY = '000801:Tracked.esp';
const CHILD_FORM_KEY = '000802:Tracked.esp';
const SECOND_CHILD_FORM_KEY = '000804:Tracked.esp';
const HELD_FORM_KEY = '000801:Held.esp';
const NOT_HELD_FORM_KEY = '000999:Nobody.esp';
const RENDERED_REFERRER_FORM_KEY = '000803:Fallout4.esm';
const TRACKED_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'modbench-tracked-')), TRACKED_ORIGIN, 'plugin-source', TRACKED_PLUGIN, 'Weapons', 'TrackedGun.json');
fs.mkdirSync(path.dirname(TRACKED_FILE), { recursive: true });
fs.writeFileSync(TRACKED_FILE, JSON.stringify({
  FormKey: TRACKED_FORM_KEY, EditorID: 'TrackedGun', Model: HELD_FORM_KEY, Placed: [
    { FormKey: CHILD_FORM_KEY, EditorID: 'TrackedRef', Base: HELD_FORM_KEY }, { FormKey: SECOND_CHILD_FORM_KEY, EditorID: 'SecondRef' },
  ],
}));
const TRACKED_FS_PATH = vscode.Uri.file(TRACKED_FILE).fsPath;
const copyQuery = (formKey: string, plugin: string, origin: string) => `formKey=${encodeURIComponent(formKey)}&name=${plugin}&origin=${origin}`;
const trackedChildUri = `modbench-child-record:${vscode.Uri.file(TRACKED_FILE).path}?${copyQuery(CHILD_FORM_KEY, TRACKED_PLUGIN, TRACKED_ORIGIN)}`;
const renderedUri = (formKey: string) =>
  `modbench-rendered:/Data/Fallout4.esm/${renderedName(formKey)}?${copyQuery(formKey, 'Fallout4.esm', 'Data')}`;


const UNTRACKED_FORM_KEY = '000801:Untracked.esp';
const UNTRACKED_FILE_NAME = 'UntrackedGun - 000801_Untracked.esp.json';
let untrackedText = '{ "EditorID": "UntrackedGun" }';

const MOCK_COMPARISONS = new Map<string, CompareResult>([[TRACKED_FORM_KEY, comparisonOf(TRACKED_FORM_KEY, [
  { plugin: TRACKED_PLUGIN, isWinner: true, editorId: 'TrackedGun' },
])], [CHILD_FORM_KEY, comparisonOf(CHILD_FORM_KEY, [
  { plugin: TRACKED_PLUGIN, origin: TRACKED_ORIGIN, isWinner: true, editorId: 'TrackedRef' },
])], [HELD_FORM_KEY, comparisonOf(HELD_FORM_KEY, [
  { plugin: 'Held.esp', isWinner: false, editorId: 'OldGun' },
  { plugin: 'Patch.esp', isWinner: true, editorId: 'NewGun', fields: [
    fieldOf({ name: 'Armor', type: 'formKey', validFormKeyTypes: ['WEAP'] }),
    fieldOf({ name: 'Name', type: 'string' }),
    fieldOf({ name: 'Mode', type: 'enum', enumMembers: [{ value: 'Auto' }, { value: 'Single' }] }),
  ] },
])]]);

before(async function () {
  this.timeout(15000);

  mockBackend = createMockBackend();
  await new Promise<void>(r => mockBackend.listen(TEST_PORT, '127.0.0.1', () => r()));

  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  const deadline = Date.now() + 5000;
  while (ext && !ext.isActive && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  await waitFor('Modbench to launch mEdit and open its notification stream', () => sseClients.length > 0);
});

after(async () => {
  mockBackend.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    mockBackend.close(err => (err ? reject(err) : resolve()))
  );
});

function modbenchLog(): string {
  const log = fs.readdirSync(LOGS, { recursive: true, encoding: 'utf8' }).find((file) => file.endsWith(path.join(EXTENSION_ID, 'Modbench.log')));
  return log === undefined ? '' : fs.readFileSync(path.join(LOGS, log), 'utf8');
}

describe('Modbench output channel', () => {
  it('writes a leveled log, as a LogOutputChannel does and a plain text channel does not', async () => {
    await waitFor('a leveled line in the Modbench log', () => /\[(trace|debug|info|warning|error)\]/.test(modbenchLog()));
  });
});

describe('modbench command registration', () => {
  const EXPECTED_COMMANDS = contributed('commands').map((c) => (isRecord(c) && typeof c.command === 'string' ? c.command : ''));

  it('registers all expected commands on activation', async () => {
    assert.ok(EXPECTED_COMMANDS.length > 0, 'derived command list is empty — the manifest shape changed');
    const all = await vscode.commands.getCommands(true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `Command not registered: ${cmd}`);
    }
  });
});

describe('Mod sync', () => {
  let original = '';

  before(() => { original = fs.readFileSync(modlistPath, 'utf8'); });
  after(() => fs.writeFileSync(modlistPath, original));

  it('drops the line of a folder gone from mods/ from the active profile', async () => {
    fs.writeFileSync(modlistPath, '+Gone Mod\r\n');

    await waitFor('mod sync to drop the line', () => !fs.readFileSync(modlistPath, 'utf8').includes('Gone Mod'));
  });
});

const openTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);
const renderedName = (formKey: string) => `${formKey.replace(':', '_')}.json`;
function renderedText(formKey: string): string {
  return JSON.stringify({
    FormKey: formKey,
    ...(formKey === RENDERED_REFERRER_FORM_KEY && { Base: HELD_FORM_KEY }),
    ...(formKey === HELD_FORM_KEY && { Template: HELD_FORM_KEY }),
  });
}

describe('modbench.record.open', () => {
  const hasRenderedTab = (formKey: string) => openTabs().some(t => t.label === renderedName(formKey));

  it('opens the winning copy\'s document, titled with its file\'s name', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000001' });

    await waitFor('the winning copy\'s tab', () => hasRenderedTab('Fallout4.esm:000001') || undefined);
  });

  it('a second click replaces the preview tab instead of adding one', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000002' });
    await waitFor('the second record\'s tab', () => hasRenderedTab('Fallout4.esm:000002') || undefined);

    assert.strictEqual(openTabs().length, tabsBefore, 'the next click replaces the preview editor');
    assert.ok(!hasRenderedTab('Fallout4.esm:000001'), 'the first record\'s preview tab is gone');
  });

  it('shows a record already open in a tab of its own, and does not open it twice', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000010', placement: 'beside' });
    await waitFor('the pinned tab', () => hasRenderedTab('Fallout4.esm:000010') || undefined);
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000010' });

    assert.strictEqual(openTabs().length, tabsBefore);
  });

  it('opens several records at once as one grid: the first record\'s document, which reads the others beside it in the order given', async () => {
    const tabsBefore = openTabs().length;
    const winner = { name: 'Fallout4.esm', origin: 'Data' };
    const copies = [{ formKey: 'Fallout4.esm:000011', plugin: winner }, { formKey: 'Fallout4.esm:000012', plugin: winner }];
    const askedSideBySide = () => comparedSideBySide.some((asked) => JSON.stringify(asked) === JSON.stringify(copies));

    await vscode.commands.executeCommand('modbench.record.open', [
      { formKey: 'Fallout4.esm:000011' }, { formKey: 'Fallout4.esm:000012' },
    ]);
    await waitFor('the first record\'s tab', () => hasRenderedTab('Fallout4.esm:000011') || undefined);
    await waitFor('the records read side by side', askedSideBySide);

    assert.strictEqual(openTabs().length, tabsBefore + 1);
    assert.ok(!hasRenderedTab('Fallout4.esm:000012'), 'the second record is a column, not a tab');
  });

  it('opens beside as a genuinely new tab, leaving the tab it was fired from alone', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000020', placement: 'beside' });
    await waitFor('the seed tab', () => hasRenderedTab('Fallout4.esm:000020') || undefined);
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000021', placement: 'beside' });
    await waitFor('the beside tab', () => hasRenderedTab('Fallout4.esm:000021') || undefined);

    assert.strictEqual(openTabs().length, tabsBefore + 1);
    assert.ok(hasRenderedTab('Fallout4.esm:000020'), 'the seed tab is untouched');
  });

  it('reads the Argument of a Plugins-tree row from a menu to its own record', async () => {
    const row = { kind: 'record', argument: { kind: 'record', plugin: { name: 'Fallout4.esm', origin: 'Data' }, formKey: 'Fallout4.esm:000030' } };

    await vscode.commands.executeCommand('modbench.record.openToSide', row, [row]);

    await waitFor('the RecordNode\'s tab', () => hasRenderedTab('Fallout4.esm:000030') || undefined);
  });

  it('reads the Argument of a placed row from a menu to its own record', async () => {
    const row = { kind: 'placed', argument: { kind: 'record', plugin: { name: 'Fallout4.esm', origin: 'Data' }, formKey: 'Fallout4.esm:000040' } };

    await vscode.commands.executeCommand('modbench.record.openToSide', row, [row]);

    await waitFor('the ChildRecordNode\'s tab', () => hasRenderedTab('Fallout4.esm:000040') || undefined);
  });

  it('a menu\'s multi-selection opens one grid, pinned, in a new group beside the active one', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    const selection = [
      { formKey: 'Fallout4.esm:000060' }, { formKey: 'Fallout4.esm:000061' }, { formKey: 'Fallout4.esm:000062' },
    ];

    await vscode.commands.executeCommand('modbench.record.openToSide', selection[0], selection);
    const tab = await waitFor('the first selected record\'s tab', () =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === renderedName('Fallout4.esm:000060')));

    const tabsByGroup = vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => t.label));
    assert.deepStrictEqual(tabsByGroup, [[], [renderedName('Fallout4.esm:000060')]]);
    assert.strictEqual(tab.isPreview, false);
  });

  it('opens the headers of two untracked plugins of one file name from different origins as two tabs', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', { header: { name: 'Twin.esp', origin: 'ModA' }, placement: 'beside' });
    await vscode.commands.executeCommand('modbench.record.open', { header: { name: 'Twin.esp', origin: 'ModB' }, placement: 'beside' });
    await waitFor('both Twin.esp tabs', () => openTabs().filter(t => t.label === '000000_Twin.esp.json').length === 2 || undefined);

    assert.strictEqual(openTabs().length, tabsBefore + 2);
  });
});

const PROBE_SPACING_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a tracked copy of a record', () => {
  const trackedCopy = { formKey: TRACKED_FORM_KEY, plugin: { name: TRACKED_PLUGIN, origin: TRACKED_ORIGIN } };
  const fileTabs = () => openTabs().filter((t) =>
    t.input instanceof vscode.TabInputCustom && t.input.uri.fsPath === TRACKED_FS_PATH && t.input.viewType === 'modbench.record');
  const reads = () => requestLog.filter((line) => line === `GET /records/${encodeURIComponent(TRACKED_FORM_KEY)}/compare`).length;
  const trackedPlugin = present(MOCK_PLUGINS.find((p) => p.name === TRACKED_PLUGIN), 'the tracked plugin\'s row');

  before(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });
  afterEach(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });

  it('opens as its file in the record grid, titled with the file\'s name after its read lands', async () => {
    const readsBefore = reads();

    await vscode.commands.executeCommand('modbench.record.open', trackedCopy);
    const [tab] = await waitFor('the file\'s tab', () => fileTabs().length > 0 && fileTabs());
    await waitFor('the record\'s read', () => reads() > readsBefore);
    await sleep(500);

    assert.strictEqual(tab?.label, 'TrackedGun.json');
    assert.deepStrictEqual(fileTabs().map((t) => t.label), ['TrackedGun.json']);
  });

  it('reads its own column from the file on disk while it is saved and its plugin is not active, so it shows', async () => {
    Object.assign(trackedPlugin, { inLoadOrder: false });
    try {
      await vscode.commands.executeCommand('modbench.record.open', trackedCopy);

      await waitFor('a read of the saved text', () => comparedTexts.includes(fs.readFileSync(TRACKED_FILE, 'utf8')));
    } finally {
      Object.assign(trackedPlugin, { inLoadOrder: true });
    }
  });

  it('reads its own column from the file\'s unsaved text', async () => {
    await vscode.commands.executeCommand('modbench.record.open', trackedCopy);
    await waitFor('the file\'s tab', () => fileTabs().length > 0);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(TRACKED_FILE));
    const saved = document.getText();
    const replaceAll = async (text: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      await vscode.workspace.applyEdit(edit);
    };
    const unsaved = JSON.stringify({ FormKey: TRACKED_FORM_KEY, EditorID: 'Unsaved' });

    try {
      await replaceAll(unsaved);
      await waitFor('a read of the unsaved text', () => comparedTexts.includes(unsaved));
    } finally {
      await replaceAll(saved);
      await document.save();
    }
  });

  it('opens as its file when it wins and the record is given without a plugin', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: TRACKED_FORM_KEY });

    await waitFor('the file\'s tab', () => fileTabs().length === 1);
  });

  it('shows the file already open in a tab, and does not open it twice', async () => {
    await vscode.commands.executeCommand('modbench.record.open', trackedCopy);
    await waitFor('the file\'s tab', () => fileTabs().length > 0);
    await vscode.commands.executeCommand('workbench.action.keepEditor');
    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000070' });
    await waitFor('both tabs', () => openTabs().length === 2 || undefined);

    await vscode.commands.executeCommand('modbench.record.open', trackedCopy);

    await waitFor('the file\'s tab active', () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom && input.uri.fsPath === TRACKED_FS_PATH;
    });
    assert.strictEqual(openTabs().length, 2);
  });

  it('shows the file already open in a tab, which reads beside its own the records opened with it, and none once its record is opened alone', async () => {
    await vscode.commands.executeCommand('modbench.record.open', trackedCopy);
    await waitFor('the file\'s tab', () => fileTabs().length > 0);
    const copies = [trackedCopy, { formKey: 'Fallout4.esm:000070', plugin: { name: 'Fallout4.esm', origin: 'Data' } }];

    await vscode.commands.executeCommand('modbench.record.open', [trackedCopy, { formKey: 'Fallout4.esm:000070' }]);
    await waitFor('the records read side by side', () => comparedSideBySide.some((asked) => JSON.stringify(asked) === JSON.stringify(copies)));
    const readsBefore = reads();
    await vscode.commands.executeCommand('modbench.record.open', trackedCopy);

    await waitFor('the record read alone', () => reads() > readsBefore);
    assert.strictEqual(openTabs().length, 1);
  });

  it('opens in the record grid by the route VS Code opens any file by, reading the record mEdit says it holds', async () => {
    const asked = `GET /plugin-source/record?path=${encodeURIComponent(TRACKED_FS_PATH)}`;
    const readsBefore = requestLog.filter((line) => line === asked).length;

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(TRACKED_FILE));

    await waitFor('the file\'s tab in the record grid', () => fileTabs().length === 1);
    await waitFor('mEdit asked which record the file holds', () => requestLog.filter((line) => line === asked).length > readsBefore);
  });
});

describe('a child record of a tracked plugin', () => {
  const plugin = { name: TRACKED_PLUGIN, origin: TRACKED_ORIGIN };
  const childCopy = { formKey: CHILD_FORM_KEY, plugin };
  const containerText = fs.readFileSync(TRACKED_FILE, 'utf8');
  const recordTabs = () => openTabs().filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'modbench.record');
  const childTab = () => recordTabs().find((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.scheme !== 'file');
  const childUri = () => {
    const input = childTab()?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
  };
  const childDocument = async () => {
    const tab = await waitFor('the child\'s tab', childTab);
    if (!(tab.input instanceof vscode.TabInputCustom)) throw new Error('expected a custom editor tab');
    return vscode.workspace.openTextDocument(tab.input.uri);
  };

  const OTHER_CELL = path.join(path.dirname(TRACKED_FILE), 'OtherCell.json');

  before(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });
  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(TRACKED_FILE, containerText);
    fs.rmSync(OTHER_CELL, { force: true });
    carriedIn.clear();
    heldIn.clear();
    answerEdit = () => refusedAsUntracked;
  });

  const reportChanged = (formKey: string) => {
    for (const res of sseClients) writeSseFrame(res, 'rows-changed', { plugin: plugin.name, origin: plugin.origin, keys: [formKey] });
  };

  it('follows its record to the file that carries it now, as when its cell\'s file moves or it crosses into another cell', async () => {
    fs.writeFileSync(OTHER_CELL, containerText);
    heldIn.set(vscode.Uri.file(OTHER_CELL).fsPath, '000803:Tracked.esp');
    await vscode.commands.executeCommand('modbench.record.open', childCopy);
    await childDocument();
    carriedIn.set(CHILD_FORM_KEY, OTHER_CELL);

    reportChanged(CHILD_FORM_KEY);

    await waitFor('the child\'s tab on the file that carries it now', () => childUri()?.path === vscode.Uri.file(OTHER_CELL).path);
    assert.strictEqual(recordTabs().length, 1);
  });

  it('follows, in each child\'s tab of a moved container, its own record, the tab in the background staying there and the focus where it was', async () => {
    fs.writeFileSync(OTHER_CELL, containerText);
    heldIn.set(vscode.Uri.file(OTHER_CELL).fsPath, '000803:Tracked.esp');
    for (const formKey of [CHILD_FORM_KEY, SECOND_CHILD_FORM_KEY]) {
      await vscode.commands.executeCommand('modbench.record.open', { formKey, plugin });
      await waitFor('the child\'s tab', () => recordTabs().some((t) => t.input instanceof vscode.TabInputCustom
        && new URLSearchParams(t.input.uri.query).get('formKey') === formKey));
      await vscode.commands.executeCommand('workbench.action.keepEditor');
    }
    await vscode.commands.executeCommand('modbench.record.open', { formKey: TRACKED_FORM_KEY, plugin, placement: 'beside' });
    await waitFor('the container\'s tab in focus beside them', () => vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.Two);
    carriedIn.set(CHILD_FORM_KEY, OTHER_CELL);
    carriedIn.set(SECOND_CHILD_FORM_KEY, OTHER_CELL);

    reportChanged(CHILD_FORM_KEY);

    const childGroup = () => present(vscode.window.tabGroups.all.find((group) => group.viewColumn === vscode.ViewColumn.One), 'the children\'s group');
    const shows = (tab: vscode.Tab | undefined) =>
      tab?.input instanceof vscode.TabInputCustom ? [tab.input.uri.path, new URLSearchParams(tab.input.uri.query).get('formKey')] : [];
    await waitFor('both children\'s tabs on the file that carries them now, the focus back beside them', () =>
      childGroup().tabs.length === 2 && childGroup().tabs.every((tab) => shows(tab)[0] === vscode.Uri.file(OTHER_CELL).path)
      && vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.Two);
    assert.deepStrictEqual(childGroup().tabs.map((tab) => shows(tab)[1]).sort(), [CHILD_FORM_KEY, SECOND_CHILD_FORM_KEY]);
    assert.deepStrictEqual(shows(childGroup().activeTab), [vscode.Uri.file(OTHER_CELL).path, SECOND_CHILD_FORM_KEY]);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.Two);
  });

  it('follows its record to the FormKey an edit of its FormID gives it', async () => {
    const NEW_KEY = '000F00:Tracked.esp';
    await vscode.commands.executeCommand('modbench.record.open', childCopy);
    await childDocument();
    answerEdit = () => ({ status: 200, body: {
      formKey: CHILD_FORM_KEY, path: 'FormKey', moves: [], newFormKey: NEW_KEY, documents: [{ path: TRACKED_FILE, text: containerText }],
    } });

    await vscode.commands.executeCommand('modbench.record.editField',
      { formKey: CHILD_FORM_KEY, plugin: plugin.name, origin: plugin.origin }, { op: 'set', path: [{ kind: 'member', name: 'FormKey' }], value: NEW_KEY });
    reportChanged(NEW_KEY);

    await waitFor('the child\'s tab on its new FormKey', () => new URLSearchParams(childUri()?.query).get('formKey') === NEW_KEY);
    assert.strictEqual(recordTabs().length, 1);
  });

  it('opens in a tab of its own beside its container\'s, on its container\'s file, titled with its own name', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: TRACKED_FORM_KEY, plugin });
    await vscode.commands.executeCommand('modbench.record.open', { ...childCopy, placement: 'beside' });

    await waitFor('the child\'s tab titled with its EditorID', () => childTab()?.label === 'TrackedRef');
    assert.deepStrictEqual(recordTabs().map((t) => t.label).sort(), ['TrackedGun.json', 'TrackedRef']);
    assert.strictEqual((await childDocument()).getText(), containerText);
  });

  it('leaves its container\'s file, opened by the route VS Code opens any file by, to open the container\'s tab', async () => {
    await vscode.commands.executeCommand('modbench.record.open', childCopy);
    await childDocument();
    await vscode.commands.executeCommand('workbench.action.keepEditor');

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(TRACKED_FILE));

    await waitFor('the container\'s own tab', () => recordTabs().some((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.scheme === 'file'));
    assert.strictEqual(recordTabs().length, 2);
  });

  it('shows a change saved from its tab in its container\'s tab beside it, and one saved from the container\'s in its own', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: TRACKED_FORM_KEY, plugin });
    await vscode.commands.executeCommand('modbench.record.open', { ...childCopy, placement: 'beside' });
    const child = await childDocument();
    const container = await vscode.workspace.openTextDocument(vscode.Uri.file(TRACKED_FILE));
    const replaceAll = async (document: vscode.TextDocument, text: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      await vscode.workspace.applyEdit(edit);
      await document.save();
    };

    const fromChild = JSON.stringify({ FormKey: TRACKED_FORM_KEY, EditorID: 'SavedFromChild' });
    await replaceAll(child, fromChild);
    assert.strictEqual(fs.readFileSync(TRACKED_FILE, 'utf8'), fromChild);
    await waitFor('the container\'s file to show the child\'s save', () => container.getText() === fromChild);

    const fromContainer = JSON.stringify({ FormKey: TRACKED_FORM_KEY, EditorID: 'SavedFromContainer' });
    await replaceAll(container, fromContainer);
    for (const res of sseClients) writeSseFrame(res, 'rows-changed', { plugin: plugin.name, origin: plugin.origin, keys: [TRACKED_FORM_KEY] });
    await waitFor('the child\'s document to show the container\'s save', () => child.getText() === fromContainer);
  });
});

describe('an edit in a tracked copy\'s grid', () => {
  const plugin = { name: TRACKED_PLUGIN, origin: TRACKED_ORIGIN };
  const savedText = fs.readFileSync(TRACKED_FILE, 'utf8');
  const MOVED_FILE = path.join(path.dirname(TRACKED_FILE), 'Moved.json');
  const MOVED_FORM_KEY = '000900:Tracked.esp';
  const edit = (formKey: string, value: unknown) => vscode.commands.executeCommand(
    'modbench.record.editField', { formKey, plugin: plugin.name, origin: plugin.origin }, { op: 'set', path: [{ kind: 'member', name: 'Edits' }], value });
  const editedText = ({ text, value }: EditAsked) => `${text}+${String(value)}`;
  const answeredIn = (file: string, moved: { moves: unknown[]; newFormKey: string } = { moves: [], newFormKey: '' }) => (asked: EditAsked): EditAnswer => ({
    status: 200,
    body: { formKey: TRACKED_FORM_KEY, path: 'Edits', ...moved, newFormKey: moved.newFormKey || null, documents: [{ path: file, text: editedText(asked) }] },
  });
  const recordTabsOn = (fsPath: string) => openTabs().filter((t) =>
    t.input instanceof vscode.TabInputCustom && t.input.viewType === 'modbench.record' && t.input.uri.fsPath === fsPath);
  const openFileTab = async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: TRACKED_FORM_KEY, plugin });
    await waitFor('the file\'s tab', () => recordTabsOn(TRACKED_FS_PATH).length > 0);
  };
  const shown = (document: vscode.TextDocument) => ({ text: document.getText(), unsaved: document.isDirty });

  before(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });
  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    answerEdit = () => refusedAsUntracked;
    if (fs.existsSync(MOVED_FILE)) fs.renameSync(MOVED_FILE, TRACKED_FILE);
    fs.writeFileSync(TRACKED_FILE, savedText);
  });

  it('changes the file\'s document to the text mEdit answers for the document\'s own text, and saves it', async () => {
    await openFileTab();
    answerEdit = answeredIn(TRACKED_FILE);

    await edit(TRACKED_FORM_KEY, 1);

    assert.strictEqual(editsAsked.at(-1)?.text, savedText);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(TRACKED_FILE));
    assert.deepStrictEqual(shown(document), { text: `${savedText}+1`, unsaved: false });
    assert.strictEqual(fs.readFileSync(TRACKED_FILE, 'utf8'), `${savedText}+1`);
  });

  it('is undone by VS Code\'s Undo in the tab, over the document', async () => {
    await openFileTab();
    answerEdit = answeredIn(TRACKED_FILE);
    await edit(TRACKED_FORM_KEY, 1);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(TRACKED_FILE));
    await waitFor('the edit in the document', () => document.getText() === `${savedText}+1`);

    await vscode.commands.executeCommand('undo');

    await waitFor('the document as it was before the edit', () => document.getText() === savedText);
  });

  it('builds each edit on the text the one before it left, the second fired before the first is saved', async () => {
    await openFileTab();
    answerEdit = answeredIn(TRACKED_FILE);

    await Promise.all([edit(TRACKED_FORM_KEY, 1), edit(TRACKED_FORM_KEY, 2)]);

    assert.strictEqual(fs.readFileSync(TRACKED_FILE, 'utf8'), `${savedText}+1+2`);
  });

  it('changes no document when mEdit refuses the edit, and says why, naming the field', async () => {
    await openFileTab();

    await edit(TRACKED_FORM_KEY, 1);

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(TRACKED_FILE));
    assert.deepStrictEqual(shown(document), { text: savedText, unsaved: false });
    await waitFor('the refusal in the Modbench log', () => modbenchLog().includes('warning: Edits: Tracked.esp is not tracked, so it is read-only.'));
  });

  it('moves the file where mEdit answers, and the tab goes with it, reading the record it moved to from the document', async () => {
    await openFileTab();
    answerEdit = answeredIn(MOVED_FILE, { moves: [{ from: TRACKED_FILE, to: MOVED_FILE }], newFormKey: MOVED_FORM_KEY });
    const readsBefore = comparedTexts.length;

    await edit(TRACKED_FORM_KEY, 'moved');

    await waitFor('the tab on the moved file', () => recordTabsOn(vscode.Uri.file(MOVED_FILE).fsPath).length === 1);
    assert.deepStrictEqual(recordTabsOn(TRACKED_FS_PATH), []);
    assert.strictEqual(fs.existsSync(TRACKED_FILE), false);
    const moved = await vscode.workspace.openTextDocument(vscode.Uri.file(MOVED_FILE));
    assert.deepStrictEqual(shown(moved), { text: `${savedText}+moved`, unsaved: false });
    await waitFor('the moved tab to read its new record from the document', () => comparedTexts.slice(readsBefore).includes(`${savedText}+moved`));
  });

  it('moves the file with the tab, which keeps beside its record the records it showed beside it', async () => {
    const column = { formKey: 'Fallout4.esm:000070', plugin: { name: 'Fallout4.esm', origin: 'Data' } };
    const openedAt = comparedSideBySide.length;
    await vscode.commands.executeCommand('modbench.record.open', [{ formKey: TRACKED_FORM_KEY, plugin }, column]);
    await waitFor('the records read side by side', () => comparedSideBySide.slice(openedAt).some((asked) => JSON.stringify(asked).includes(column.formKey)));
    answerEdit = answeredIn(MOVED_FILE, { moves: [{ from: TRACKED_FILE, to: MOVED_FILE }], newFormKey: MOVED_FORM_KEY });
    const readsBefore = comparedSideBySide.length;

    await edit(TRACKED_FORM_KEY, 'moved');

    await waitFor('the moved tab to read its new record beside the same records', () => comparedSideBySide.slice(readsBefore).some((asked) =>
      Array.isArray(asked) && JSON.stringify(asked.map((copy: unknown) => isRecord(copy) && copy.formKey)) === JSON.stringify([MOVED_FORM_KEY, column.formKey])));
  });

  it('edits a child record through its own tab\'s document', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: CHILD_FORM_KEY, plugin });
    const tab = await waitFor('the child\'s tab', () => openTabs().find((t) =>
      t.input instanceof vscode.TabInputCustom && t.input.viewType === 'modbench.record' && t.input.uri.scheme !== 'file'));
    if (!(tab.input instanceof vscode.TabInputCustom)) throw new Error('expected a custom editor tab');
    const child = await vscode.workspace.openTextDocument(tab.input.uri);
    answerEdit = answeredIn(TRACKED_FILE);

    await edit(CHILD_FORM_KEY, 1);

    assert.deepStrictEqual(shown(child), { text: `${savedText}+1`, unsaved: false });
    assert.strictEqual(fs.readFileSync(TRACKED_FILE, 'utf8'), `${savedText}+1`);
  });
});

describe('a record opened from a column\'s header, in its tab\'s place', () => {
  const copyOf = (formKey: string) => ({ formKey, plugin: { name: 'Fallout4.esm', origin: 'Data' } });
  const shown = () => vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => `${t.label}${t.isPreview ? ' (preview)' : ''}`));
  const openTab = async (formKey: string) => {
    await vscode.commands.executeCommand('modbench.record.open', copyOf(formKey));
    await waitFor(`${formKey}'s tab active`, () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === renderedName(formKey));
  };
  const openPinned = async (formKey: string) => {
    await openTab(formKey);
    await vscode.commands.executeCommand('workbench.action.keepEditor');
  };
  const placeOf = (formKey: string) => {
    const group = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label === renderedName(formKey)));
    const input = group?.tabs.find((t) => t.label === renderedName(formKey))?.input;
    if (!group || !(input instanceof vscode.TabInputCustom)) throw new Error(`expected ${formKey}'s record tab`);
    return { document: input.uri.toString(), viewColumn: group.viewColumn };
  };
  const openInPlaceOf = (replaced: string, formKey: string) =>
    vscode.commands.executeCommand('modbench.record.open', [{ ...copyOf(formKey), placement: placeOf(replaced) }]);
  const openInPlace = (formKey: string) => {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
    const replaced = ['80', '81', '82', '83', '84'].map((n) => `Fallout4.esm:0000${n}`).find((f) => renderedName(f) === active);
    if (!replaced) throw new Error('expected a record tab active');
    return openInPlaceOf(replaced, formKey);
  };
  const tabsAre = (labels: string[]) => waitFor(`the tabs ${labels.join(', ')}`, () => JSON.stringify(shown()) === JSON.stringify([labels]));

  before(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });
  afterEach(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });

  it('takes a pinned tab\'s place, pinned, whichever side of the active tab VS Code opens a new one on', async () => {
    const positioning = vscode.workspace.getConfiguration('workbench.editor');
    await positioning.update('openPositioning', 'last', vscode.ConfigurationTarget.Workspace);
    try {
      for (const formKey of ['Fallout4.esm:000080', 'Fallout4.esm:000081', 'Fallout4.esm:000082']) await openPinned(formKey);
      await openTab('Fallout4.esm:000081');

      await openInPlace('Fallout4.esm:000083');

      await tabsAre(['Fallout4.esm:000080', 'Fallout4.esm:000083', 'Fallout4.esm:000082'].map(renderedName));
    } finally {
      await positioning.update('openPositioning', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('takes a preview tab\'s place, as a preview', async () => {
    await openPinned('Fallout4.esm:000080');
    await openTab('Fallout4.esm:000081');

    await openInPlace('Fallout4.esm:000083');

    await tabsAre([renderedName('Fallout4.esm:000080'), `${renderedName('Fallout4.esm:000083')} (preview)`]);
  });

  it('takes the tab\'s place with a record already open in a tab left of it, which moves there', async () => {
    for (const n of ['80', '81', '82', '83', '84']) await openPinned(`Fallout4.esm:0000${n}`);
    await openTab('Fallout4.esm:000083');

    await openInPlace('Fallout4.esm:000081');

    await tabsAre(['80', '82', '81', '84'].map((n) => renderedName(`Fallout4.esm:0000${n}`)));
  });

  it('takes the place of the tab it was asked from, though another tab is active by the time it opens', async () => {
    for (const n of ['80', '81', '82']) await openPinned(`Fallout4.esm:0000${n}`);

    await openInPlaceOf('Fallout4.esm:000081', 'Fallout4.esm:000083');

    await tabsAre(['80', '83', '82'].map((n) => renderedName(`Fallout4.esm:0000${n}`)));
  });
});

describe('an untracked copy of a record', () => {
  const untrackedCopy = { formKey: UNTRACKED_FORM_KEY, plugin: { name: 'Untracked.esp', origin: 'UntrackedMod' } };
  const renderedTabs = () => openTabs().filter((t) =>
    t.input instanceof vscode.TabInputCustom && t.input.uri.scheme === 'modbench-rendered' && t.input.viewType === 'modbench.record');
  const renderedDocument = async () => {
    const [tab] = await waitFor('the copy\'s tab', () => renderedTabs().length > 0 && renderedTabs());
    if (!(tab?.input instanceof vscode.TabInputCustom)) throw new Error('expected a custom editor tab');
    return vscode.workspace.openTextDocument(tab.input.uri);
  };

  before(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });
  afterEach(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });

  it('opens in the record grid as the document mEdit renders, titled with the name its file would have', async () => {
    await vscode.commands.executeCommand('modbench.record.open', untrackedCopy);

    const document = await renderedDocument();
    assert.deepStrictEqual(renderedTabs().map((t) => t.label), [UNTRACKED_FILE_NAME]);
    assert.strictEqual(document.getText(), untrackedText);
  });

  it('opens in the record grid by the route VS Code opens any document by', async () => {
    await vscode.commands.executeCommand('modbench.record.open', untrackedCopy);
    const { uri } = await renderedDocument();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await vscode.commands.executeCommand('vscode.open', uri);

    await waitFor('the copy\'s tab in the record grid', () => renderedTabs().length === 1);
  });

  it('reads mEdit\'s rendering again when mEdit reports the copy changed', async () => {
    await vscode.commands.executeCommand('modbench.record.open', untrackedCopy);
    const document = await renderedDocument();

    untrackedText = '{ "EditorID": "UntrackedGun", "Name": "Changed" }';
    for (const res of sseClients) {
      writeSseFrame(res, 'rows-changed', { plugin: untrackedCopy.plugin.name, origin: untrackedCopy.plugin.origin, keys: [UNTRACKED_FORM_KEY] });
    }

    await waitFor('the document to change', () => document.getText() === untrackedText);
  });
});

async function downloadsRows(): Promise<string[]> {
  await vscode.env.clipboard.writeText('');
  await vscode.commands.executeCommand('modbench.downloads.focus');
  await vscode.commands.executeCommand('list.selectAll');
  await vscode.commands.executeCommand('modbench.copyValue', copyValueKeyArgs('modbench.downloads'));
  const text = await vscode.env.clipboard.readText();
  return text === '' ? [] : text.split('\n');
}

describe('modbench.downloads tree', () => {
  const downloadsDir = path.join(root, 'downloads');
  const iniPath = path.join(root, 'ModOrganizer.ini');

  async function repointDownloads(iniText: string, landed: (rows: readonly string[]) => boolean): Promise<void> {
    fs.writeFileSync(iniPath, iniText);
    await waitFor('the Downloads view to follow ModOrganizer.ini', async () => landed(await downloadsRows()));
  }

  async function probeUntilListed(dir: string, prefix: string): Promise<void> {
    await sleep(PROBE_SPACING_MS);
    const written = new Set<string>();
    await waitFor(`a file written into ${dir}, once no read is in flight to pick it up, to reach the Downloads tree through the watcher`, async () => {
      const name = `${prefix}-${written.size}.zip`;
      written.add(name);
      fs.writeFileSync(path.join(dir, name), 'data');
      const deadline = Date.now() + PROBE_SPACING_MS;
      do {
        if ((await downloadsRows()).some((row) => written.has(row))) return true;
      } while (Date.now() < deadline);
      return undefined;
    }, 35000);
  }

  before(() => fs.mkdirSync(downloadsDir, { recursive: true }));
  after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  it('reflects a new archive dropped into downloads/ via the file-watcher, with no manual refresh', async () => {
    await probeUntilListed(downloadsDir, 'dropped');
  });

  it('scans and watches a downloads folder ModOrganizer.ini points outside the instance', async function () {
    this.timeout(40000);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-external-downloads-'));
    const originalIni = fs.readFileSync(iniPath, 'utf8');
    try {
      fs.writeFileSync(path.join(external, 'external-preexisting.zip'), 'data');
      await repointDownloads(`${originalIni}[Settings]\r\ndownload_directory=${external}\r\n`,
        (rows) => rows.includes('external-preexisting.zip'));

      await probeUntilListed(external, 'external-new');
    } finally {
      await repointDownloads(originalIni, (rows) => !rows.some((row) => row.startsWith('external-')));
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('watches a downloads folder ModOrganizer.ini points at before it exists on disk', async function () {
    this.timeout(40000);
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-notyet-downloads-'));
    const notYetCreated = path.join(container, 'NotYetCreated');
    const originalIni = fs.readFileSync(iniPath, 'utf8');
    const marker = 'in-the-instance-downloads.zip';
    const listsMarker = (rows: readonly string[]) => rows.includes(marker);
    try {
      fs.writeFileSync(path.join(downloadsDir, marker), 'data');
      await waitFor('the instance\'s own downloads folder to be listed', async () => listsMarker(await downloadsRows()));
      await repointDownloads(`${originalIni}[Settings]\r\ndownload_directory=${notYetCreated}\r\n`, (rows) => rows.length === 0);

      fs.mkdirSync(notYetCreated);
      await probeUntilListed(notYetCreated, 'created');
    } finally {
      await repointDownloads(originalIni, listsMarker);
      fs.rmSync(container, { recursive: true, force: true });
    }
  });
});

const xdgTrash = path.join(present(process.env.XDG_DATA_HOME, 'the data directory .vscode-test.mjs hands the run'), 'Trash');
const trashInfoDir = path.join(xdgTrash, 'info');
const TRASH_INFO = '.trashinfo';

function trashInfoNames(): ReadonlySet<string> {
  return new Set(fs.existsSync(trashInfoDir) ? fs.readdirSync(trashInfoDir) : []);
}

function takeFromTrash(original: string, before: ReadonlySet<string>): number {
  let taken = 0;
  for (const info of trashInfoNames()) {
    if (before.has(info) || !info.endsWith(TRASH_INFO)) continue;
    const pathLine = fs.readFileSync(path.join(trashInfoDir, info), 'utf8').split('\n').find((l) => l.startsWith('Path='));
    if (pathLine === undefined || decodeURIComponent(pathLine.slice('Path='.length)) !== original) continue;
    fs.rmSync(path.join(xdgTrash, 'files', info.slice(0, -TRASH_INFO.length)), { recursive: true, force: true });
    fs.rmSync(path.join(trashInfoDir, info));
    taken++;
  }
  return taken;
}

async function selectFirstRow(view: string, expected: string): Promise<void> {
  await waitFor(`${expected} to be the focused and selected row of ${view}`, async () => {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand(`${view}.focus`);
    await vscode.commands.executeCommand(`workbench.actions.treeView.${view}.collapseAll`);
    await vscode.commands.executeCommand('list.focusFirst');
    await vscode.commands.executeCommand('list.selectAndPreserveFocus');
    await vscode.commands.executeCommand('modbench.copyValue', copyValueKeyArgs(view));
    return (await vscode.env.clipboard.readText()) === expected;
  });
}

describe('Delete separator, as VS Code runs it on the Mods view\'s selection', () => {
  const doomedDir = path.join(root, 'mods', 'Doomed_separator');
  let original = '';
  let trashedBefore: ReadonlySet<string> = new Set();

  before(() => {
    trashedBefore = trashInfoNames();
    original = fs.readFileSync(modlistPath, 'utf8');
    fs.mkdirSync(doomedDir, { recursive: true });
    fs.writeFileSync(modlistPath, '-Doomed_separator\r\n');
  });

  after(() => {
    takeFromTrash(doomedDir, trashedBefore);
    fs.rmSync(doomedDir, { recursive: true, force: true });
    fs.writeFileSync(modlistPath, original);
  });

  it('takes its line from modlist.txt and its folder to the OS trash', async () => {
    await selectFirstRow('modbench.modList', 'Doomed');
    const warn = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = () => Promise.resolve('Delete');
    try {
      await vscode.commands.executeCommand('modbench.separator.delete');

      assert.ok(!fs.readFileSync(modlistPath, 'utf8').includes('Doomed'), 'the delete should have written modlist.txt');
      assert.ok(!fs.existsSync(doomedDir), 'the delete should have taken the separator\'s folder from mods/');
      if (process.platform === 'linux') {
        assert.strictEqual(takeFromTrash(doomedDir, trashedBefore), 1, 'the separator\'s folder should be in the OS trash');
      }
    } finally {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = warn;
    }
  });
});

describe('The Mods view\'s palette entries, as VS Code runs them', () => {
  const modDir = path.join(root, 'mods', 'Palette Mod');
  let original = '';

  const enabledAndSelected = async () => {
    fs.writeFileSync(modlistPath, '+Palette Mod\r\n');
    await selectFirstRow('modbench.modList', 'Palette Mod');
  };

  before(async () => {
    original = fs.readFileSync(modlistPath, 'utf8');
    fs.mkdirSync(modDir, { recursive: true });
    await waitFor('mod sync to give the new folder its line', () => fs.readFileSync(modlistPath, 'utf8').includes('Palette Mod'));
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    fs.writeFileSync(modlistPath, original);
    fs.rmSync(modDir, { recursive: true, force: true });
  });

  it('copies the selection of the view last selected in when Copy Value is run from the palette', async function () {
    this.timeout(30_000);
    await enabledAndSelected();
    await vscode.env.clipboard.writeText('');
    await waitFor('the palette\'s copy value to reach the clipboard', async () => {
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Modbench: Copy Value');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return (await vscode.env.clipboard.readText()) === 'Palette Mod';
    });
  });

  it('offers Disable Mod in the palette while the Mods view has focus, acting on its selection', async function () {
    this.timeout(30_000);
    await enabledAndSelected();
    await waitFor('the palette\'s disable to reach modlist.txt', async () => {
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Modbench: Disable Mod');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return fs.readFileSync(modlistPath, 'utf8').includes('-Palette Mod');
    });
  });
});

describe('modbench.plugin.create', () => {
  const modName = 'Create Mod';
  const modDir = path.join(root, 'mods', modName);
  let original = '';
  let originalPlugins = '';
  const { showInputBox, showQuickPick } = vscode.window;

  before(async function () {
    this.timeout(30_000);
    original = fs.readFileSync(modlistPath, 'utf8');
    originalPlugins = fs.readFileSync(pluginsTxtPath, 'utf8');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(modlistPath, '+Create Mod\r\n');
    await selectFirstRow('modbench.modList', modName);
  });

  after(() => {
    Object.assign(vscode.window, { showInputBox, showQuickPick });
    fs.writeFileSync(modlistPath, original);
    fs.writeFileSync(pluginsTxtPath, originalPlugins);
    fs.rmSync(modDir, { recursive: true, force: true });
  });

  it('puts the new plugin\'s line, disabled, at the end of plugins.txt', async function () {
    this.timeout(30_000);
    let offered: readonly string[] = [];
    let pick = (places: readonly { label: string }[]): Promise<{ label: string } | undefined> => {
      offered = places.map((place) => place.label);
      return Promise.resolve(undefined);
    };
    Object.assign(vscode.window, {
      showInputBox: () => Promise.resolve('Created.esp'),
      showQuickPick: (places: readonly { label: string }[]) => pick(places),
    });
    await waitFor('the Instance to offer the mod as a place', async () => {
      await vscode.commands.executeCommand('modbench.plugin.create');
      return offered.includes(modName);
    });
    pick = (places) => Promise.resolve(places.find((place) => place.label === modName));

    await vscode.commands.executeCommand('modbench.plugin.create');

    assert.ok(fs.existsSync(path.join(modDir, 'Created.esp')), 'the mock backend writes the file into the chosen mod');
    await waitFor('plugin sync to put the line in plugins.txt', () => /^Created\.esp\r?$/m.test(fs.readFileSync(pluginsTxtPath, 'utf8')));
    const lines = fs.readFileSync(pluginsTxtPath, 'utf8').split(/\r?\n/).filter((line) => line !== '');
    assert.strictEqual(lines.at(-1), 'Created.esp');
  });
});

describe('The Plugins view\'s keys, as VS Code runs them', () => {
  let gameDir = '';
  let original = '';

  before(async () => {
    original = fs.readFileSync(pluginsTxtPath, 'utf8');
    gameDir = gameFolderHolding('medit-keys-', ['TestMod.esp', 'Other.esp']);
    await setGameDirectory(gameDir);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setGameDirectory(FIXTURE_GAME_DIRECTORY);
    fs.writeFileSync(pluginsTxtPath, original);
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('Space disables the selected plugin', async () => {
    await holdPluginsTxt('*TestMod.esp\r\nOther.esp\r\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await selectFirstRow('modbench.pluginListTree', 'TestMod.esp');

    await vscode.commands.executeCommand('modbench.plugin.disable');

    await waitFor('the disable to reach plugins.txt', () => /^TestMod\.esp\r?$/m.test(fs.readFileSync(pluginsTxtPath, 'utf8')));
  });
});

describe('The game-directory setting reaches the Instance as a recompute', () => {
  let providing = '';
  let empty = '';

  before(() => {
    providing = gameFolderHolding('medit-game-', ['TestMod.esp']);
    empty = gameFolderHolding('medit-game-', []);
  });

  after(async () => {
    await setGameDirectory(FIXTURE_GAME_DIRECTORY);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(providing, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('lands a value plugin sync reads, with no file of the instance touched: the line the Data folder it now names does not provide goes', async () => {
    await setGameDirectory(providing);
    await holdPluginsTxt('*TestMod.esp\n');

    await setGameDirectory(empty);

    await waitFor('plugin sync to drop the line', () => !fs.readFileSync(pluginsTxtPath, 'utf8').includes('TestMod.esp'));
  });
});

describe('Modbench, launching mEdit with the extension, puts the load order before it asks for plugins', () => {
  it('PUTs /load-order before the first GET /plugins the mock backend has heard since the extension activated', async () => {
    await waitFor('a PUT /load-order', () => requestLog.includes('PUT /load-order'));

    const load = requestLog.indexOf('PUT /load-order');
    assert.ok(!requestLog.slice(0, load).includes('GET /plugins'), 'GET /plugins must not fire before PUT /load-order');
  });
});

describe('An instance change sends a fresh load order snapshot (ADR-0013)', () => {
  let gameDir = '';
  let swapped = false;
  const putCount = () => requestLog.filter((l) => l === 'PUT /load-order').length;

  async function swapPluginOrder(): Promise<void> {
    swapped = !swapped;
    await writePluginsTxt(swapped ? '*Second.esp\n*TestMod.esp\n' : '*TestMod.esp\n*Second.esp\n');
  }

  async function writePluginsTxt(text: string): Promise<void> {
    const before = putCount();
    const pluginReads = requestLog.filter((l) => l === 'GET /plugins').length;
    fs.writeFileSync(pluginsTxtPath, text);
    await waitFor('a fresh PUT /load-order after plugins.txt changed', () => putCount() > before ? true : undefined);
    await waitFor('the tree hand-off after the PUT', () => requestLog.filter((l) => l === 'GET /plugins').length > pluginReads ? true : undefined);
  }

  before(async () => {
    gameDir = gameFolderHolding('medit-reconcile-', ['TestMod.esp', 'Second.esp']);
    await setGameDirectory(gameDir);
    await holdPluginsTxt('*TestMod.esp\n*Second.esp\n');
  });

  after(async () => {
    await setGameDirectory(FIXTURE_GAME_DIRECTORY);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('a plugins.txt write is followed by a fresh PUT /load-order, no command required', async () => {
    const before = putCount();

    await swapPluginOrder();

    assert.ok(putCount() >= before + 1, 'a plugins.txt change must send a fresh snapshot, not merely re-render the tree');
  });

  it('a plugins.txt write that leaves the load order equal puts it again', async () => {
    const sent = putLoadOrders.length;
    const order = swapped ? ['Second.esp', 'TestMod.esp'] : ['TestMod.esp', 'Second.esp'];

    await writePluginsTxt(`${fs.readFileSync(pluginsTxtPath, 'utf8')}\n`);

    assert.deepStrictEqual(putLoadOrders.slice(sent), [order]);
  });
});

describe('Refresh rebuilds the index, then re-reads the instance', () => {
  afterEach(() => { rebuildIndexShouldFail = false; });

  it('POSTs /index/rebuild, then PUTs the load order the re-read built', async () => {
    const since = requestLog.length;

    await vscode.commands.executeCommand('modbench.instance.refresh');

    const rebuilt = requestLog.indexOf('POST /index/rebuild', since);
    assert.ok(rebuilt !== -1, 'modbench.instance.refresh must rebuild the index');
    await waitFor('a PUT /load-order after the rebuild',
      () => requestLog.slice(rebuilt).includes('PUT /load-order') ? true : undefined);
  });

  it('reports that another window holds the index, naming this instance', async () => {
    rebuildIndexShouldFail = true;
    const since = requestLog.length;
    const errors: string[] = [];
    const realShowError = vscode.window.showErrorMessage;
    Object.defineProperty(vscode.window, 'showErrorMessage', {
      configurable: true,
      value: (message: string) => { errors.push(message); return Promise.resolve(undefined); },
    });
    try {
      await vscode.commands.executeCommand('modbench.instance.refresh');

      assert.ok(requestLog.slice(since).includes('POST /index/rebuild'), 'sanity: the rebuild must still be attempted');
      assert.strictEqual(errors.length, 1, `expected exactly one error toast, got: ${JSON.stringify(errors)}`);
      const [toast] = errors;
      assert.ok(
        toast?.includes("This instance's index is open in another Modbench window"),
        `expected the refusal's words, got: ${toast}`,
      );
      assert.ok(toast?.includes(root), `expected the instance named, got: ${toast}`);
      assert.ok(!toast?.includes(RAW_INDEX_LOCKED_DETAIL), `expected the backend's raw detail kept out of the toast, got: ${toast}`);
    } finally {
      Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: realShowError });
    }
  });
});

const markdownText = (content: vscode.Hover['contents'][number]): string => (content instanceof vscode.MarkdownString ? content.value : '');

describe('A FormKey in plugin source', () => {
  let folder = '';
  let document: vscode.TextDocument;

  before(async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-plugin-source-'));
    const file = path.join(folder, 'plugin-source', 'Held.esp', 'Gun.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ FormKey: HELD_FORM_KEY, Armor: NOT_HELD_FORM_KEY, Name: 'Rusty Gun', Mode: 'Auto' }, null, 2));
    document = await vscode.workspace.openTextDocument(file);
  });
  after(() => fs.rmSync(folder, { recursive: true, force: true }));

  const positionIn = (text: string) => document.positionAt(document.getText().indexOf(text) + 1);
  const hoverTextsIn = async (doc: vscode.TextDocument, text: string): Promise<string[]> => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', doc.uri, doc.positionAt(doc.getText().indexOf(text) + 1));
    return hovers.flatMap((hover) => hover.contents.map(markdownText));
  };
  const hoverTexts = (text: string) => hoverTextsIn(document, text);
  const heldHover = [`\`NewGun [${HELD_FORM_KEY}]\`\n\nWeapon\n\nWinner: Patch.esp`];
  const activated = () => waitFor('the FormKey hover', async () => {
    const shown = await hoverTexts(HELD_FORM_KEY);
    return shown.length > 0 && shown;
  });
  const documentAt = async (...segments: string[]) => {
    const file = path.join(folder, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ FormKey: HELD_FORM_KEY, Armor: NOT_HELD_FORM_KEY, Mode: 'Auto' }));
    return vscode.workspace.openTextDocument(file);
  };

  it('shows its record on hover: EditorID, FormKey, record type and the winning plugin', async () => {
    assert.deepStrictEqual(await activated(), heldHover);
  });

  it('shows no hover for a FormKey no active plugin holds', async () => {
    await activated();
    const asked = requestLog.length;
    const texts = await hoverTexts(NOT_HELD_FORM_KEY);

    assert.deepStrictEqual(texts, []);
    assert.ok(requestLog.slice(asked).some((line) => line.includes(encodeURIComponent(NOT_HELD_FORM_KEY))), 'sanity: mEdit was asked');
  });

  it('shows its record in a plugin source folder the adapter names in another case', async () => {
    await activated();
    const other = await documentAt('Mods', 'Plugin-Source', 'Held.esp', 'Gun.json');

    assert.deepStrictEqual(await hoverTextsIn(other, '000801'), heldHover);
  });

  it('shows no hover in JSON outside the plugin source folder', async () => {
    await activated();
    const other = await documentAt('Other.json');

    assert.deepStrictEqual(await hoverTextsIn(other, '000801'), []);
  });

  it('shows no hover for text that is not a FormKey', async () => {
    await activated();
    assert.deepStrictEqual(await hoverTexts('Rusty'), []);
  });

  const definitionsOf = async (formKey: string): Promise<vscode.Location[]> => {
    const referencing = path.join(folder, 'plugin-source', 'Held.esp', 'References', `${formKey.replace(':', '_')}.json`);
    fs.mkdirSync(path.dirname(referencing), { recursive: true });
    fs.writeFileSync(referencing, JSON.stringify({ FormKey: HELD_FORM_KEY, Armor: formKey }));
    const doc = await vscode.workspace.openTextDocument(referencing);
    return vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider', doc.uri, doc.positionAt(doc.getText().indexOf(formKey) + 1));
  };
  const definedText = async ({ uri, range }: vscode.Location) => (await vscode.workspace.openTextDocument(uri)).getText(range);

  it('goes to the definition of a FormKey whose winning copy is tracked: its file, at the record\'s own FormKey member', async () => {
    await activated();
    const [definition, ...more] = await definitionsOf(TRACKED_FORM_KEY);

    assert.deepStrictEqual(more, []);
    assert.strictEqual(definition?.uri.fsPath, TRACKED_FS_PATH);
    assert.strictEqual(await definedText(definition), `"FormKey":"${TRACKED_FORM_KEY}"`);
  });

  it('goes to the definition of a FormKey whose winning copy is untracked: mEdit\'s rendering of it, at the record\'s own FormKey member', async () => {
    await activated();
    const [definition, ...more] = await definitionsOf(HELD_FORM_KEY);

    assert.deepStrictEqual(more, []);
    assert.strictEqual(definition?.uri.toString(true), renderedUri(HELD_FORM_KEY));
    assert.strictEqual(await definedText(definition), `"FormKey":"${HELD_FORM_KEY}"`);
  });

  it('goes to the definition of a FormKey whose winning copy is a child record: its own tab on its owner\'s file, at its own FormKey member', async () => {
    await activated();
    for (const res of sseClients) writeSseFrame(res, 'rows-changed', { plugin: TRACKED_PLUGIN, origin: TRACKED_ORIGIN, keys: [CHILD_FORM_KEY] });

    const definition = await waitFor('the definition on the child\'s own member', async () => {
      const [found, ...more] = await definitionsOf(CHILD_FORM_KEY);
      return more.length === 0 && found?.uri.toString(true) === trackedChildUri && await definedText(found) === `"FormKey":"${CHILD_FORM_KEY}"` && found;
    });

    assert.strictEqual(definition.range.start.character, fs.readFileSync(TRACKED_FILE, 'utf8').indexOf(`"FormKey":"${CHILD_FORM_KEY}"`));
  });

  it('lists every record that references it, one entry for each plugin\'s copy at its reference, a record referencing itself never at its declaration', async () => {
    await activated();
    const found = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', document.uri, positionIn(HELD_FORM_KEY));
    const entries = await Promise.all(found.map(async ({ uri, range }) =>
      [uri.toString(true), (await vscode.workspace.openTextDocument(uri)).offsetAt(range.start)]));
    const tracked = fs.readFileSync(TRACKED_FILE, 'utf8');
    const quoted = `"${HELD_FORM_KEY}"`;

    assert.deepStrictEqual(entries.sort(), [
      [vscode.Uri.file(TRACKED_FILE).toString(true), tracked.indexOf(quoted)],
      [trackedChildUri, tracked.lastIndexOf(quoted)],
      [renderedUri(RENDERED_REFERRER_FORM_KEY), renderedText(RENDERED_REFERRER_FORM_KEY).indexOf(quoted)],
      [renderedUri(HELD_FORM_KEY), renderedText(HELD_FORM_KEY).lastIndexOf(quoted)],
    ].sort());
  });

  it('lists no references in JSON outside the plugin source folder', async () => {
    await activated();
    const other = await documentAt('Other.json');
    const found = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider', other.uri, other.positionAt(other.getText().indexOf(HELD_FORM_KEY) + 1));

    assert.deepStrictEqual(found, []);
  });

  it('has no definition in JSON outside the plugin source folder', async () => {
    await activated();
    const other = await documentAt('Other.json');
    const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider', other.uri, other.positionAt(other.getText().indexOf(HELD_FORM_KEY) + 1));

    assert.deepStrictEqual(definitions, []);
  });

  it('has no definition for a FormKey no active plugin holds', async () => {
    await activated();
    const asked = requestLog.length;

    assert.deepStrictEqual(await definitionsOf(NOT_HELD_FORM_KEY), []);
    assert.ok(requestLog.slice(asked).includes(`GET /records/${encodeURIComponent(NOT_HELD_FORM_KEY)}`), 'sanity: mEdit was asked');
  });

  it('finds a record across the tracked plugins by Go to Symbol in Workspace, each copy at its document', async () => {
    await activated();
    const asked = requestLog.length;
    const found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'Tracked');

    assert.deepStrictEqual(found.map((symbol) => [symbol.name, symbol.containerName, symbol.location.uri.toString(true)]).sort(), [
      [`TrackedGun [${TRACKED_FORM_KEY}]`, `${TRACKED_PLUGIN} (${TRACKED_ORIGIN})`, vscode.Uri.file(TRACKED_FILE).toString(true)],
      [`TrackedRef [${CHILD_FORM_KEY}]`, `${TRACKED_PLUGIN} (${TRACKED_ORIGIN})`, trackedChildUri],
    ].sort());
    assert.deepStrictEqual(requestLog.slice(asked).filter((line) => line.startsWith('GET /records?')).map((line) => {
      const query = new URL(line.slice('GET '.length), 'http://x').searchParams;
      return [query.get('search'), query.get('plugin'), query.get('origin')];
    }), [['Tracked', TRACKED_PLUGIN, TRACKED_ORIGIN]]);
  });

  const offeredIn = async (doc: vscode.TextDocument, text: string): Promise<string[]> => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(doc.getText().indexOf(text) + 2));
    return list.items.filter((item) => item.insertText === HELD_FORM_KEY).map((item) => typeof item.label === 'string' ? item.label : item.label.label);
  };

  it('completes a reference field by EditorID, inserting the FormKey', async () => {
    await activated();
    assert.deepStrictEqual(await offeredIn(document, NOT_HELD_FORM_KEY), ['NewGun']);
  });

  const labelsIn = async (doc: vscode.TextDocument, text: string): Promise<string[]> => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(doc.getText().indexOf(text) + 1));
    return list.items.flatMap((item) => item.kind === vscode.CompletionItemKind.EnumMember ? [typeof item.label === 'string' ? item.label : item.label.label] : []);
  };

  it('completes an enum field with its values', async () => {
    await activated();
    assert.deepStrictEqual(await labelsIn(document, 'Auto'), ['Auto', 'Single']);
  });

  it('completes no enum values in JSON outside the plugin source folder', async () => {
    await activated();
    const other = await documentAt('Other.json');
    assert.deepStrictEqual(await labelsIn(other, 'Auto'), []);
  });

  it('completes no field that is not a reference', async () => {
    await activated();
    assert.deepStrictEqual(await offeredIn(document, 'Rusty'), []);
  });

  it('completes no reference in JSON outside the plugin source folder', async () => {
    await activated();
    const other = await documentAt('Other.json');
    assert.deepStrictEqual(await offeredIn(other, NOT_HELD_FORM_KEY), []);
  });

  it('offers no quick fix', async () => {
    const position = positionIn(HELD_FORM_KEY);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider', document.uri, new vscode.Range(position, position), vscode.CodeActionKind.QuickFix.value);

    assert.deepStrictEqual(actions, []);
  });

  it('offers no Rename Symbol', async () => {
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
      'vscode.executeDocumentRenameProvider', document.uri, positionIn(HELD_FORM_KEY), '000802:Held.esp').then(
      (renamed) => renamed, () => undefined);

    assert.strictEqual(edit?.size ?? 0, 0);
  });
});

describe('The Problems panel on plugin source', () => {
  const MESSAGE = `Armor: [${NOT_HELD_FORM_KEY}] <Error: Could not be resolved>`;
  const SOURCE_FILE = path.join('plugin-source', 'Held.esp', 'Gun.json');
  const file = path.join(FIXTURE_GAME_DIRECTORY, 'Data', SOURCE_FILE);
  const plugin = { name: 'Held.esp', origin: 'Data' };

  before(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ FormKey: HELD_FORM_KEY, Armor: NOT_HELD_FORM_KEY }, null, 2));
  });
  after(() => {
    pluginProblems = [];
    fs.rmSync(path.join(FIXTURE_GAME_DIRECTORY, 'Data', 'plugin-source'), { recursive: true, force: true });
  });

  const saved = (problems: PluginProblems['problems']) => {
    pluginProblems = [{ plugin, problems }];
    for (const res of sseClients) writeSseFrame(res, 'rows-changed', { plugin: plugin.name, origin: plugin.origin, keys: [HELD_FORM_KEY] });
  };
  const shown = () => vscode.languages.getDiagnostics(vscode.Uri.file(file)).filter((diagnostic) => diagnostic.message === MESSAGE);

  it('carries a reference to a record no active plugin holds on its file, spanning that FormKey, and clears it when a save answers none', async () => {
    saved([{ formKey: HELD_FORM_KEY, targetFormKey: NOT_HELD_FORM_KEY, sourceRelativePath: SOURCE_FILE, message: MESSAGE }]);

    const [problem] = await waitFor('the problem on its file', () => { const found = shown(); return found.length > 0 && found; });
    const document = await vscode.workspace.openTextDocument(file);
    assert.strictEqual(document.getText(problem?.range), `"${NOT_HELD_FORM_KEY}"`);

    saved([]);
    await waitFor('the problem to clear', () => shown().length === 0);
  });
});

async function waitFor<T>(label: string, read: () => Promise<T | false | undefined> | T | false | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
