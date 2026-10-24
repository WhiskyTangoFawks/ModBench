// The FOMOD engine runs in its own process: on Linux its add-on finds its library only through LD_LIBRARY_PATH, read
// when a process starts, and a fault in native code ends this process, never the extension host.

import { join } from 'node:path';
import type { types } from '@nexusmods/fomod-installer-native';
import { errorMessage } from '../../ports/errorMessage';
import { isRequest, type ConditionFacts, type EngineReport, type Known, type Selection } from './engineProtocol';

// The reference installer answers this for FOMM's version, whatever its own.
const FOMM_VERSION = '0.13.21';

interface Dialog {
  readonly select: types.SelectCallback;
  readonly cont: types.ContinueCallback;
  readonly cancel: types.CancelCallback;
}

let dialog: Dialog | undefined;
// The engine reports a step inside each call that changes it.
let cause: 'select' | 'move' = 'move';

const report = (message: EngineReport, then?: () => void): void => {
  process.send?.(message, undefined, undefined, then);
};

const exit = (): void => process.exit(0);

// The engine passes no image at all for a module that names none.
const headerImagePath = (image: types.IHeaderImage | null): string => image?.path ?? '';

const isEngine = (value: unknown): value is types.IExtension => typeof value === 'object' && value !== null && 'ModInstaller' in value;

function answer<T>(question: string, known: Known<T>, unanswered: T): T {
  if ('known' in known) return known.known;
  report({ kind: 'unanswered', question, why: known.unknown });
  return unanswered;
}

function engineIn(engineFolder: string): types.IExtension {
  const engine = { exports: {} };
  process.dlopen(engine, join(engineFolder, 'modinstaller.napi.node'));
  if (!isEngine(engine.exports)) throw new Error(`${engineFolder} holds no FOMOD engine`);
  return engine.exports;
}

function install(engineFolder: string, root: string, files: readonly string[], facts: ConditionFacts): void {
  let engine: types.IExtension;
  try {
    engine = engineIn(engineFolder);
  } catch (err) {
    report({ kind: 'broken', message: errorMessage(err) }, exit);
    return;
  }
  engine.FileSystem.setDefaultCallbacks();
  const plugins = (activeOnly: boolean): string[] => {
    const known = answer('the plugins', facts.plugins, { present: [], active: [] });
    return [...(activeOnly ? known.active : known.present)];
  };
  const installer = new engine.ModInstaller(
    plugins,
    () => FOMM_VERSION,
    () => answer('the game\'s version', facts.gameVersion, ''),
    () => answer('the script extender\'s version', facts.extenderVersion, ''),
    (module, image, select, cont, cancel) => {
      dialog = { select, cont, cancel };
      report({ kind: 'dialog', module, image: headerImagePath(image) });
    },
    () => undefined,
    (steps, current) => report({ kind: 'step', steps, current, cause }),
  );
  installer.install([...files], [], '', root, undefined, false, false).then(
    (result) => report({ kind: 'done', result }, exit),
    (err: unknown) => report({ kind: 'failed', message: errorMessage(err) }, exit),
  );
}

function select(stepId: number, { groupId, optionIds }: Selection): void {
  cause = 'select';
  dialog?.select(stepId, groupId, [...optionIds]);
  cause = 'move';
}

process.on('message', (request: unknown) => {
  if (!isRequest(request)) return;
  switch (request.kind) {
    case 'install': return install(request.engineFolder, request.root, request.files, request.facts);
    case 'select': return select(request.stepId, request.selection);
    case 'continue': return dialog?.cont(request.forward, request.stepId);
    case 'cancel': return dialog?.cancel();
  }
});
