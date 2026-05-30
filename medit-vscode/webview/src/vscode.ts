interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
