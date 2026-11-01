/** The port of an mEdit already running, from `modbench.attachToBackendPort`; absent when this window starts its own. */
export function attachPortOf(setting: (key: string) => unknown): number | undefined {
  const port = setting('attachToBackendPort');
  return typeof port === 'number' ? port : undefined;
}
