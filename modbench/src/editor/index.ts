// Editor's own public surface, the target architecture's "Editor" box: open a record, and the
// active record. Everything else stays internal, reached by the composition root directly only
// where construction demands it (Referenced By).
export { registerEditorCommands, type EditorCommandDeps } from './recordPanelHost';
export { announceConflictsComputed } from './notificationWiring';
export { ActiveRecordTracker } from './ActiveRecordTracker';
export { EditsInFlight } from './followRecord';
