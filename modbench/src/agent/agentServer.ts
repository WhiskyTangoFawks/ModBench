import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { InstanceView } from '../instanceLoader/instance';
import type { Log } from '../ports/log';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { MEditClient } from '../client/MEditClient';
import { FILE_CONFLICTS } from './fileConflicts';
import { RUN_GESTURE } from './gestures';
import { RESOLVE_INSTANCE_NAMES } from './instanceNames';
import { INSTANCE_READS } from './instanceReads';
import { Refusal } from './refusal';
import { RESOLVE_NAMES } from './resolveNames';
import { SELECT_ROWS } from './selectRows';
import { SOURCE_PROBLEMS } from './sourceProblems';

const AGENT_PORT_SETTING = 'modbench.agent.port';

export interface AgentServerOptions {
  port: number;
  instance: Pick<InstanceView, 'value' | 'sequence'> | undefined;
  mEdit: Pick<MEditClient, 'resolveNames' | 'selectRows'>;
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
    if (!(error instanceof Refusal)) throw error;
    log.warn(`[agent] ${name}: ${error.message}`);
    return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
  }
}

function mcpServerOf({ instance, mEdit, log }: AgentServerOptions): McpServer {
  const server = new McpServer({ name: 'modbench', version: '0' });
  for (const read of INSTANCE_READS) {
    server.registerTool(read.name, { description: read.description }, () => answer(log, read.name, () => read.of(currentValue(instance))));
  }
  server.registerTool(FILE_CONFLICTS.name, { description: FILE_CONFLICTS.description, inputSchema: FILE_CONFLICTS.input },
    (args) => answer(log, FILE_CONFLICTS.name, () => FILE_CONFLICTS.of(currentValue(instance), args)));
  server.registerTool(RESOLVE_INSTANCE_NAMES.name, { description: RESOLVE_INSTANCE_NAMES.description, inputSchema: RESOLVE_INSTANCE_NAMES.input },
    (args) => answer(log, RESOLVE_INSTANCE_NAMES.name, () => RESOLVE_INSTANCE_NAMES.of(currentValue(instance), args)));
  server.registerTool(RESOLVE_NAMES.name, { description: RESOLVE_NAMES.description, inputSchema: RESOLVE_NAMES.input },
    (args) => answer(log, RESOLVE_NAMES.name, () => RESOLVE_NAMES.of(mEdit, args)));
  server.registerTool(SELECT_ROWS.name, { description: SELECT_ROWS.description, inputSchema: SELECT_ROWS.input },
    (args) => answer(log, SELECT_ROWS.name, () => SELECT_ROWS.of(mEdit, args)));
  server.registerTool(RUN_GESTURE.name, { description: RUN_GESTURE.description, inputSchema: RUN_GESTURE.input },
    (args) => answer(log, RUN_GESTURE.name, () => RUN_GESTURE.of(currentValue(instance), args)));
  server.registerTool(SOURCE_PROBLEMS.name, { description: SOURCE_PROBLEMS.description }, () => answer(log, SOURCE_PROBLEMS.name, SOURCE_PROBLEMS.of));
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
