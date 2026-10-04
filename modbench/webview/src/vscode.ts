import { type WebviewToExtension } from '../../src/wire/messages';
import type { ConflictTableReady } from '../../src/wire/conflictTable';

interface VsCodeApi<Message> {
  // An arrow-typed property, not a method: `postMessage` never needs its own `this`, and this
  // shape lets a test hold a bare reference to it (`vi.mocked(vscode.postMessage)`) without an
  // unbound-method warning.
  postMessage: (msg: Message) => void;
}

// VS Code hands a page this once; each page posts its own protocol through it.
declare function acquireVsCodeApi(): VsCodeApi<unknown>;

const api = acquireVsCodeApi();

export const vscode: VsCodeApi<WebviewToExtension> = api;

export const conflictTableHost: VsCodeApi<ConflictTableReady> = api;
