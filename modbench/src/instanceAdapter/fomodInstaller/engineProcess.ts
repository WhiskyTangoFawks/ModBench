// The FOMOD engine runs in its own process: on Linux its add-on finds its library only through LD_LIBRARY_PATH,
// read at start. A test runs this source as it is, so it imports only Node's modules at run time.

import { join } from 'node:path';
import type { types } from '@nexusmods/fomod-installer-native';
import type { ConditionFacts, EngineReport, EngineRequest, Known } from './engineProtocol';

// The reference installer answers this for FOMM's version, whatever its own.
const FOMM_VERSION = '0.13.21';

interface Dialog {
  readonly select: types.SelectCallback;
  readonly cont: types.ContinueCallback;
  readonly cancel: types.CancelCallback;
}

let dialog: Dialog | undefined;

const report = (message: EngineReport, then?: () => void): void => {
  process.send?.(message, undefined, undefined, then);
};

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isRequest = (value: unknown): value is EngineRequest => typeof value === 'object' && value !== null && 'kind' in value;

const isEngine = (value: unknown): value is types.IExtension => typeof value === 'object' && value !== null && 'ModInstaller' in value;

function answer<T>(question: string, known: Known<T>, unanswered: T): T {
  if ('known' in known) return known.known;
  report({ kind: 'unanswered', question, why: known.unknown });
  return unanswered;
}

function install(engineFolder: string, root: string, files: readonly string[], facts: ConditionFacts): void {
  const engine = { exports: {} };
  process.dlopen(engine, join(engineFolder, 'modinstaller.napi.node'));
  if (!isEngine(engine.exports)) throw new Error(`${engineFolder} holds no FOMOD engine`);
  engine.exports.FileSystem.setDefaultCallbacks();
  const plugins = (activeOnly: boolean): string[] => {
    const known = answer('the plugins', facts.plugins, { present: [], active: [] });
    return [...(activeOnly ? known.active : known.present)];
  };
  const installer = new engine.exports.ModInstaller(
    plugins,
    () => FOMM_VERSION,
    () => answer('the game\'s version', facts.gameVersion, ''),
    () => answer('the script extender\'s version', facts.extenderVersion, ''),
    (_module, _image, select, cont, cancel) => {
      dialog = { select, cont, cancel };
    },
    () => undefined,
    (steps, current) => report({ kind: 'step', steps, current }),
  );
  installer.install([...files], [], '', root, undefined, false, false).then(
    (result) => report({ kind: 'done', result }, () => process.exit(0)),
    (err: unknown) => report({ kind: 'failed', message: reasonOf(err) }, () => process.exit(0)),
  );
}

process.on('message', (request: unknown) => {
  if (!isRequest(request)) return;
  switch (request.kind) {
    case 'install': return install(request.engineFolder, request.root, request.files, request.facts);
    case 'select': return dialog?.select(request.stepId, request.groupId, [...request.optionIds]);
    case 'continue': return dialog?.cont(true, request.stepId);
    case 'cancel': return dialog?.cancel();
  }
});
