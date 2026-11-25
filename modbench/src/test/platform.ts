import { describe, it } from 'vitest';

type Registration = (name: string, body: () => void | Promise<void>, timeout?: number) => void;
type Registrar = Registration & { skipIf(condition: boolean): Registration };

const unregistered: Registrar = Object.assign((): void => undefined, { skipIf: (): Registration => unregistered });

// `it` and `describe` for what exists on one platform: elsewhere nothing registers, so nothing reports as a skip.
const on = (here: boolean): { it: Registrar; describe: Registrar } => (here ? { it, describe } : { it: unregistered, describe: unregistered });

export const onPosix = on(process.platform !== 'win32');
export const onWindows = on(process.platform === 'win32');
