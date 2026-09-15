import { type WebviewToExtension } from './messages';

interface VsCodeApi {
  // An arrow-typed property, not a method: `postMessage` never needs its own `this`, and this
  // shape lets a test hold a bare reference to it (`vi.mocked(vscode.postMessage)`) without an
  // unbound-method warning.
  postMessage: (msg: WebviewToExtension) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
