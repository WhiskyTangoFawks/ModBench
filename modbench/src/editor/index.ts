// The Editor's public surface; Referenced By is reached by the composition root directly.
export { registerEditorCommands, type EditorCommandDeps } from './recordPanelHost';
export { announceConflictsComputed } from './notificationWiring';
export { ActiveRecordTracker } from './ActiveRecordTracker';
export { EditsInFlight } from './followRecord';
