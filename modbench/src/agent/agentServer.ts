import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CopyReads } from '../drivingLib/sameCopies';
import { ArchivedCopies } from '../drivingLib/archivedCopies';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { instanceMessages, type InstanceView } from '../instanceLoader/instance';
import type { Log } from '../ports/log';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { MEditClient } from '../client/MEditClient';
import type { Source } from './source';
import { AGENT_PORT_SETTING } from './agentPort';
import { FILE_CONFLICTS } from './fileConflicts';
import { GESTURE_TOOLS } from './gestures';
import { RESOLVE_INSTANCE_NAMES } from './instanceNames';
import { INSTANCE_LISTS, LIST_PROFILES, type DeploymentRead } from './instanceReads';
import { LIST_PLUGINS } from './listPlugins';
import { LIST_SORTING_RULES } from './listSortingRules';
import { withNotRestored } from './notRestored';
import { Refusal } from '../drivingLib/refusal';
import { parseOrRefuse } from './refusal';
import { LIST_MOD_STATUSES } from './modStatuses';
import type { ModStatuses } from '../modStatus/modStatuses';
import { LIST_REFERENCES, READ_RECORD } from './readRecord';
import { RESOLVE_NAMES } from './resolveNames';
import { SCRIPT_ENVIRONMENT, type TerminalEnvironment } from './scriptEnvironment';
import { SELECT_ROWS } from './selectRows';
import { PROBLEMS } from './problems';
import { READ_GUIDE } from './readGuide';
import { INSTRUCTIONS } from './instructions/instructions';
import { TOOL_DESCRIPTIONS } from './instructions/tools';

export interface AgentServerOptions {
  port: number;
  instance: Pick<InstanceView, 'value' | 'sequence' | 'readFailure'> | undefined;
  copyReads: CopyReads | undefined;
  mEdit: Pick<MEditClient, 'resolveNames' | 'selectRows' | 'getComparison' | 'getPlugins' | 'getCopyDocument' | 'getRenderedDocument' | 'getReferences' | 'getArchiveCopies'>;
  terminalEnvironment: TerminalEnvironment;
  statuses: Pick<ModStatuses, 'current'> | undefined;
  deployment: DeploymentRead | undefined;
  standing: Record<Exclude<Source, 'instance'>, () => readonly string[]>;
  pluginsShown: PluginsShown | undefined;
  reporter: Reporter;
  log: Log;
}

export interface AgentServer {
  dispose(): void;
  readonly listening: Promise<AddressInfo | undefined>;
}

type Instance = NonNullable<AgentServerOptions['instance']>;
type OpenOptions = AgentServerOptions & { instance: Instance; copyReads: CopyReads; statuses: Pick<ModStatuses, 'current'>; deployment: DeploymentRead; pluginsShown: PluginsShown };

function currentValue(instance: Instance) {
  if (instance.sequence === 0) throw new Refusal(instance.readFailure === undefined ? 'The instance has not been read yet.' : `Failed to load: ${instance.readFailure}`);
  return instance.value;
}

const textBlock = (text: string) => ({ type: 'text' as const, text });

// The standing lines of the sources the tool reads, each beside the answer as a block of its own.
async function answer(log: Log, standing: () => string[], name: string, work: () => unknown) {
  try {
    const result = await work();
    return { content: [textBlock(typeof result === 'string' ? result : JSON.stringify(result)), ...standing().map(textBlock)] };
  } catch (error) {
    const line = `[agent] ${name}: ${errorMessage(error)}`;
    if (error instanceof Refusal) log.warn(line);
    else log.error(line);
    const text = error instanceof Refusal && error.answer !== undefined ? JSON.stringify(error.answer) : errorMessage(error);
    return { isError: true, content: [textBlock(text), ...standing().map(textBlock)] };
  }
}

// Claude Code gives up on a call it hears neither progress nor an outcome of for 300 s.
const STILL_WORKING_MS = 15_000;

async function stillWorking({ _meta, sendNotification }: RequestHandlerExtra<ServerRequest, ServerNotification>, work: () => unknown): Promise<unknown> {
  const progressToken = _meta?.progressToken;
  if (progressToken === undefined) return work();
  let progress = 0;
  const beat = setInterval(() => {
    progress += 1;
    sendNotification({ method: 'notifications/progress', params: { progressToken, progress } }).catch(() => { clearInterval(beat); });
  }, STILL_WORKING_MS);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}

interface Tool<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly input: Shape;
}

// The SDK refuses an input its schema rejects before the handler runs, with no Output line
// (agent.md, Reporting, story 1), so it holds one that takes any object and advertises the tool's.
function register<Shape extends z.ZodRawShape>(
  server: McpServer, log: Log, standing: () => string[], { name, input }: Tool<Shape>, run: (args: z.output<z.ZodObject<Shape>>) => unknown,
): void {
  const schema = z.strictObject(input);
  const anyObject = z.looseObject({}).meta(z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }));
  server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: anyObject }, (args, extra) => answer(log, standing, name, () =>
    stillWorking(extra, () => run(parseOrRefuse(schema, args)))));
}

const NO_INPUT = {};

// Only a plugin named with its origin is matched against the origins list_plugins shows.
const namesAnOrigin = (args: unknown): boolean =>
  typeof args === 'object' && args !== null
  && Object.entries(args).some(([key, value]) => (key === 'origin' && typeof value === 'string') || namesAnOrigin(value));

const RECORD_READS: readonly Source[] = ['instance', 'mEdit', 'plugins', 'sourceLanguage'];

function mcpServerOf({ instance, copyReads, mEdit, terminalEnvironment, statuses, deployment, standing: standingSources, pluginsShown, log }: OpenOptions): McpServer {
  const server = new McpServer({ name: 'modbench', version: '0' }, { instructions: INSTRUCTIONS });
  const sources: Record<Source, () => readonly string[]> = { ...standingSources, instance: () => instanceMessages(instance).filter((line) => line !== undefined) };
  const reading = (...read: Source[]) => () => [...new Set(read.flatMap((source) => sources[source]()))];
  register(server, log, reading('instance'), { ...LIST_PROFILES, input: NO_INPUT }, () => LIST_PROFILES.of(currentValue(instance), deployment));
  for (const list of INSTANCE_LISTS) register(server, log, reading(...list.reads), list, (args) => list.of(currentValue(instance), args));
  const naming = (args?: unknown) => (namesAnOrigin(args) ? withNotRestored(currentValue(instance), statuses) : Promise.resolve(currentValue(instance)));
  register(server, log, reading('instance', 'mEdit', 'plugins', 'sortingRules'), LIST_PLUGINS, async (args) => LIST_PLUGINS.of(await withNotRestored(currentValue(instance), statuses), pluginsShown, args));
  register(server, log, reading('instance', 'mEdit', 'plugins', 'sortingRules'), LIST_SORTING_RULES, (args) => LIST_SORTING_RULES.of(pluginsShown, args));
  register(server, log, reading('instance', 'modList'), LIST_MOD_STATUSES, (args) => LIST_MOD_STATUSES.of(currentValue(instance), statuses, args));
  const archivedCopies = new ArchivedCopies(mEdit, (path) => copyReads.fileStamp(path));
  register(server, log, reading('instance', 'modList'), FILE_CONFLICTS, (args) => FILE_CONFLICTS.of(currentValue(instance), copyReads, archivedCopies, args));
  register(server, log, reading('instance', 'modList'), RESOLVE_INSTANCE_NAMES, (args) => RESOLVE_INSTANCE_NAMES.of(currentValue(instance), args));
  register(server, log, reading(...RECORD_READS), RESOLVE_NAMES, (args) => RESOLVE_NAMES.of(mEdit, args));
  register(server, log, reading(...RECORD_READS), READ_RECORD, async (args) => READ_RECORD.of(mEdit, await naming(args), args));
  register(server, log, reading(...RECORD_READS), LIST_REFERENCES, (args) => LIST_REFERENCES.of(mEdit, args));
  register(server, log, reading(...RECORD_READS), SELECT_ROWS, (args) => SELECT_ROWS.of(mEdit, args));
  for (const gesture of GESTURE_TOOLS) register(server, log, reading('instance'), gesture, async (args) => gesture.of(await naming(args), mEdit, args, (line) => { log.warn(`[agent] ${gesture.name}: ${line}`); }));
  register(server, log, reading(), { ...SCRIPT_ENVIRONMENT, input: NO_INPUT }, () => SCRIPT_ENVIRONMENT.of(terminalEnvironment));
  const problemFolders = () => {
    const { modDirs, sourceDirs, overwriteDir } = currentValue(instance).paths;
    return [...modDirs.values(), ...sourceDirs.values(), overwriteDir, deployment.folder()].filter((folder) => folder !== undefined);
  };
  register(server, log, reading('instance', 'sortingRules', 'sourceLanguage'), PROBLEMS, (args) => PROBLEMS.of(args, problemFolders));
  register(server, log, reading('instance'), READ_GUIDE, (args) => READ_GUIDE.of(currentValue(instance), args));
  return server;
}

const LOOPBACK = '127.0.0.1';

const isOwnHost = ({ headers, socket }: IncomingMessage): boolean =>
  headers.host === `${LOOPBACK}:${socket.localPort}` || headers.host === `localhost:${socket.localPort}`;

async function bodyOf(request: IncomingMessage): Promise<{ parsed: unknown } | undefined> {
  try {
    return { parsed: JSON.parse(await text(request)) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function handle(options: OpenOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isOwnHost(request) || request.headers.origin !== undefined) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  const body = await bodyOf(request);
  if (body === undefined) {
    response.writeHead(400).end();
    return;
  }
  const mcp = mcpServerOf(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => { void transport.close(); void mcp.close(); });
  await mcp.connect(transport);
  await transport.handleRequest(request, response, body.parsed);
}

const NOT_SERVING: AgentServer = { listening: Promise.resolve(undefined), dispose: () => undefined };

export function serveAgent(options: AgentServerOptions): AgentServer {
  const { instance, copyReads, statuses, deployment, pluginsShown, port, reporter, log } = options;
  if (instance === undefined || copyReads === undefined || statuses === undefined || deployment === undefined || pluginsShown === undefined) return NOT_SERVING;
  const open = { ...options, instance, copyReads, statuses, deployment, pluginsShown };
  const http = createServer((request, response) => {
    handle(open, request, response).catch((error: unknown) => {
      log.error(`[agent] ${errorMessage(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  // The extension host's loop can be held past the keep-alive window, and the expired timer then
  // resets a connection with a request already sent on it.
  http.keepAliveTimeout = 0;
  const listening = new Promise<AddressInfo | undefined>((done) => {
    http.once('error', (error) => {
      reporter.report('error', `Modbench cannot take port ${port} for your agent. Set ${AGENT_PORT_SETTING} to a free port.`, errorMessage(error));
      done(undefined);
    });
    http.listen(port, LOOPBACK, () => {
      const address = http.address();
      done(typeof address === 'object' && address !== null ? address : undefined);
    });
  });
  return { listening, dispose: () => { http.close(); http.closeAllConnections(); } };
}
