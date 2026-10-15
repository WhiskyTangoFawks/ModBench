import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { InstanceView } from '../instanceLoader/instance';
import type { Log } from '../ports/log';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { MEditClient } from '../client/MEditClient';
import { FILE_CONFLICTS } from './fileConflicts';
import { RUN_GESTURE } from './gestures';
import { RESOLVE_INSTANCE_NAMES } from './instanceNames';
import { INSTANCE_READS } from './instanceReads';
import { Refusal } from '../drivingLib/refusal';
import { parseOrRefuse } from './refusal';
import { LIST_MOD_STATUSES, type ReadModStatus } from './modStatuses';
import { LIST_REFERENCES, READ_RECORD } from './readRecord';
import { RESOLVE_NAMES } from './resolveNames';
import { SCRIPT_ENVIRONMENT, type TerminalEnvironment } from './scriptEnvironment';
import { SELECT_ROWS } from './selectRows';
import { SOURCE_PROBLEMS } from './sourceProblems';

const AGENT_PORT_SETTING = 'modbench.agent.port';

export interface AgentServerOptions {
  port: number;
  instance: Pick<InstanceView, 'value' | 'sequence'> | undefined;
  mEdit: Pick<MEditClient, 'resolveNames' | 'selectRows' | 'getComparison' | 'getCopyDocument' | 'getRenderedDocument' | 'getReferences'>;
  terminalEnvironment: TerminalEnvironment;
  /** Absent with the instance. */
  modStatus: ReadModStatus | undefined;
  reporter: Reporter;
  log: Log;
}

export interface AgentServer {
  dispose(): void;
  readonly listening: Promise<AddressInfo | undefined>;
}

function currentValue(instance: AgentServerOptions['instance']) {
  if (instance === undefined) throw new Refusal('There is no Modbench instance open in this window.');
  if (instance.sequence === 0) throw new Refusal('The instance has not been read yet.');
  return instance.value;
}

async function answer(log: Log, name: string, work: () => unknown) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await work()) }] };
  } catch (error) {
    const line = `[agent] ${name}: ${errorMessage(error)}`;
    if (error instanceof Refusal) log.warn(line);
    else log.error(line);
    const text = error instanceof Refusal && error.answer !== undefined ? JSON.stringify(error.answer) : errorMessage(error);
    return { isError: true, content: [{ type: 'text' as const, text }] };
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
  server: McpServer, log: Log, { name, description, input }: Tool<Shape>, run: (args: z.output<z.ZodObject<Shape>>) => unknown,
): void {
  const schema = z.object(input);
  const anyObject = z.looseObject({}).meta(z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }));
  server.registerTool(name, { description, inputSchema: anyObject }, (args) => answer(log, name, () => {
    return run(parseOrRefuse(schema, args));
  }));
}

const NO_INPUT = {};

const INSTRUCTIONS = `Name objects as Modbench's views do: a plugin by its file name, a mod or a separator by its name, a record by its EditorID or FormKey, a downloaded file by its file name, an archive or a folder outside the downloads by its path, a file in a mod by its path in the mod. A name that means more than one thing is refused with each match listed as you can name it; name the one you mean that way.

A plugin with source is a text file in a repository: edit it with your file tools, and the user reviews the change in Source Control. A plugin with no source is a binary: never edit it. Mod manager files change only through run_gesture. A change to many records by a rule is a script: write a Python file with import medit and run it in your shell with the variables script_environment returns.

Ask Modbench what the files cannot answer.`;

function mcpServerOf({ instance, mEdit, terminalEnvironment, modStatus, log }: AgentServerOptions): McpServer {
  const server = new McpServer({ name: 'modbench', version: '0' }, { instructions: INSTRUCTIONS });
  for (const read of INSTANCE_READS) register(server, log, { ...read, input: NO_INPUT }, () => read.of(currentValue(instance)));
  register(server, log, { ...LIST_MOD_STATUSES, input: NO_INPUT }, () => LIST_MOD_STATUSES.of(currentValue(instance), modStatus));
  register(server, log, FILE_CONFLICTS, (args) => FILE_CONFLICTS.of(currentValue(instance), args));
  register(server, log, RESOLVE_INSTANCE_NAMES, (args) => RESOLVE_INSTANCE_NAMES.of(currentValue(instance), args));
  register(server, log, RESOLVE_NAMES, (args) => RESOLVE_NAMES.of(mEdit, args));
  register(server, log, READ_RECORD, (args) => READ_RECORD.of(mEdit, currentValue(instance), args));
  register(server, log, LIST_REFERENCES, (args) => LIST_REFERENCES.of(mEdit, args));
  register(server, log, SELECT_ROWS, (args) => SELECT_ROWS.of(mEdit, args));
  register(server, log, RUN_GESTURE, (args) => RUN_GESTURE.of(currentValue(instance), mEdit, args));
  register(server, log, { ...SCRIPT_ENVIRONMENT, input: NO_INPUT }, () => SCRIPT_ENVIRONMENT.of(terminalEnvironment));
  register(server, log, { ...SOURCE_PROBLEMS, input: NO_INPUT }, SOURCE_PROBLEMS.of);
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

async function handle(options: AgentServerOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
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

export function serveAgent(options: AgentServerOptions): AgentServer {
  const { port, reporter, log } = options;
  const http = createServer((request, response) => {
    handle(options, request, response).catch((error: unknown) => {
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
