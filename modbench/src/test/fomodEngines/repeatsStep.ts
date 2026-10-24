import { isRequest, type EngineReport } from '../../instanceAdapter/fomodInstaller/engineProtocol';

const MAIN = {
  id: 0, name: 'Main', visible: true,
  optionalFileGroups: {
    order: 'Explicit' as const,
    group: [{ id: 0, name: 'Pick', type: 'SelectAny' as const, options: [{ id: 0, selected: false, preset: false, name: 'A', description: '', image: '', type: 'Optional' as const }] }],
  },
};

const report = (message: EngineReport): void => {
  process.send?.(message);
};

process.on('message', (request: unknown) => {
  if (!isRequest(request)) return;
  if (request.kind === 'cancel') report({ kind: 'done', result: null });
  else report({ kind: 'step', steps: [MAIN], current: 0 });
});
