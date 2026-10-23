import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { instanceMessages, type InstanceView } from '../instanceLoader/instance';
import type { Log } from '../ports/log';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { MEditClient } from '../client/MEditClient';
import { AGENT_PORT_SETTING } from './agentPort';
import { FILE_CONFLICTS } from './fileConflicts';
import { GESTURE_TOOLS } from './gestures';
import { RESOLVE_INSTANCE_NAMES } from './instanceNames';
import { INSTANCE_READS } from './instanceReads';
import { LIST_PLUGINS } from './listPlugins';
import { withNotRestored } from './notRestored';
import { Refusal } from '../drivingLib/refusal';
import { parseOrRefuse } from './refusal';
import { LIST_MOD_STATUSES } from './modStatuses';
import type { ReadModStatus } from '../client';
import { LIST_REFERENCES, READ_RECORD } from './readRecord';
import { RESOLVE_NAMES } from './resolveNames';
import { SCRIPT_ENVIRONMENT, type TerminalEnvironment } from './scriptEnvironment';
import { SELECT_ROWS } from './selectRows';
import { SOURCE_PROBLEMS } from './sourceProblems';

export interface AgentServerOptions {
  port: number;
  instance: Pick<InstanceView, 'value' | 'sequence' | 'readFailure'> | undefined;
  mEdit: Pick<MEditClient, 'resolveNames' | 'selectRows' | 'getComparison' | 'getCopyDocument' | 'getRenderedDocument' | 'getReferences'>;
  terminalEnvironment: TerminalEnvironment;
  readStatus: ReadModStatus | undefined;
  reporter: Reporter;
  log: Log;
}

export interface AgentServer {
  dispose(): void;
  readonly listening: Promise<AddressInfo | undefined>;
}

type Instance = NonNullable<AgentServerOptions['instance']>;
type OpenOptions = AgentServerOptions & { instance: Instance; readStatus: ReadModStatus };

function currentValue(instance: Instance) {
  if (instance.sequence === 0) throw new Refusal(instance.readFailure === undefined ? 'The instance has not been read yet.' : `Failed to load: ${instance.readFailure}`);
  return instance.value;
}

const textBlock = (text: string) => ({ type: 'text' as const, text });

// The messages every view of the instance shows, beside each answer as a block of their own.
async function answer(log: Log, standing: () => string[], name: string, work: () => unknown) {
  try {
    return { content: [textBlock(JSON.stringify(await work())), ...standing().map(textBlock)] };
  } catch (error) {
    const line = `[agent] ${name}: ${errorMessage(error)}`;
    if (error instanceof Refusal) log.warn(line);
    else log.error(line);
    const text = error instanceof Refusal && error.answer !== undefined ? JSON.stringify(error.answer) : errorMessage(error);
    return { isError: true, content: [textBlock(text), ...standing().map(textBlock)] };
  }
}

interface Tool<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly input: Shape;
}

// The SDK refuses an input its schema rejects before the handler runs, with no Output line
// (agent.md, Reporting, story 1), so it holds one that takes any object and advertises the tool's.
function register<Shape extends z.ZodRawShape>(
  server: McpServer, log: Log, standing: () => string[], { name, description, input }: Tool<Shape>, run: (args: z.output<z.ZodObject<Shape>>) => unknown,
): void {
  const schema = z.object(input);
  const anyObject = z.looseObject({}).meta(z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }));
  server.registerTool(name, { description, inputSchema: anyObject }, (args) => answer(log, standing, name, () => {
    return run(parseOrRefuse(schema, args));
  }));
}

const NO_INPUT = {};

// Only a plugin named with its origin is matched against the origins list_plugins shows.
const namesAnOrigin = (args: unknown): boolean =>
  typeof args === 'object' && args !== null
  && Object.entries(args).some(([key, value]) => (key === 'origin' && typeof value === 'string') || namesAnOrigin(value));

const INSTRUCTIONS = `Name objects as Modbench's views do: a plugin by its file name, a mod or a separator by its name, a record by its EditorID or FormKey, a downloaded file by its file name, an archive or a folder outside the downloads by its path, a file in a mod by its path in the mod. A name that means more than one thing is refused with each match listed as you can name it; name the one you mean that way.

A plugin with source is a text file in a repository: edit it with your file tools, and the user reviews the change in Source Control. A plugin with no source is a binary: never edit it. Mod manager files change only through the gesture tools. A gesture runs on the argument and options given, never on the selection, with no picker, prompt or confirmation, and answers once Modbench's views show its change: with its outcome, or with what landed and each item refused and why. A change to many records by a rule is a script: write a Python file with import medit and run it in your shell with the variables script_environment returns. help(medit) lists its functions.

A SELECT reads only the views: select_rows says which.

Ask Modbench what the files cannot answer.`;

function mcpServerOf({ instance, mEdit, terminalEnvironment, readStatus, log }: OpenOptions): McpServer {
  const server = new McpServer({ name: 'modbench', version: '0' }, { instructions: INSTRUCTIONS });
  const standing = () => instanceMessages(instance).filter((message) => message !== undefined);
  for (const read of INSTANCE_READS) register(server, log, standing, { ...read, input: NO_INPUT }, () => read.of(currentValue(instance)));
  const naming = (args?: unknown) => (namesAnOrigin(args) ? withNotRestored(currentValue(instance), readStatus) : Promise.resolve(currentValue(instance)));
  register(server, log, standing, { ...LIST_PLUGINS, input: NO_INPUT }, async () => LIST_PLUGINS.of(await withNotRestored(currentValue(instance), readStatus)));
  register(server, log, standing, { ...LIST_MOD_STATUSES, input: NO_INPUT }, () => LIST_MOD_STATUSES.of(currentValue(instance), readStatus));
  register(server, log, standing, FILE_CONFLICTS, (args) => FILE_CONFLICTS.of(currentValue(instance), args));
  register(server, log, standing, RESOLVE_INSTANCE_NAMES, (args) => RESOLVE_INSTANCE_NAMES.of(currentValue(instance), args));
  register(server, log, standing, RESOLVE_NAMES, (args) => RESOLVE_NAMES.of(mEdit, args));
  register(server, log, standing, READ_RECORD, async (args) => READ_RECORD.of(mEdit, await naming(args), args));
  register(server, log, standing, LIST_REFERENCES, (args) => LIST_REFERENCES.of(mEdit, args));
  register(server, log, standing, SELECT_ROWS, (args) => SELECT_ROWS.of(mEdit, args));
  for (const gesture of GESTURE_TOOLS) register(server, log, standing, gesture, async (args) => gesture.of(await naming(args), mEdit, args, (line) => { log.warn(`[agent] ${gesture.name}: ${line}`); }));
  register(server, log, standing, { ...SCRIPT_ENVIRONMENT, input: NO_INPUT }, () => SCRIPT_ENVIRONMENT.of(terminalEnvironment));
  register(server, log, standing, { ...SOURCE_PROBLEMS, input: NO_INPUT }, SOURCE_PROBLEMS.of);
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
  const { instance, readStatus, port, reporter, log } = options;
  if (instance === undefined || readStatus === undefined) return NOT_SERVING;
  const open = { ...options, instance, readStatus };
  const http = createServer((request, response) => {
    handle(open, request, response).catch((error: unknown) => {
      log.error(`[agent] ${errorMessage(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
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
