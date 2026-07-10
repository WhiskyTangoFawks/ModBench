import { type WebviewToExtension } from './downloadsMessages';

interface VsCodeApi {
  postMessage(msg: WebviewToExtension): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
