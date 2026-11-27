import { downloadedFileArgumentOf, modArgumentOf, pluginArgumentOf, separatorArgumentOf } from '../drivingLib/argument';
import { recordArgumentOf } from '../drivingLib/recordArgument';
import type { RecordNamed, PresentedSymbol } from './symbolKind';

/** The symbol a row stands for; undefined where it stands for none. */
export function symbolOfRow(row: unknown, dataPathOf: (row: unknown) => string | undefined): PresentedSymbol | RecordNamed | undefined {
  const record = recordArgumentOf(row);
  const plugin = pluginArgumentOf(row)?.plugin;
  const downloaded = downloadedFileArgumentOf(row)?.row.name;
  const path = dataPathOf(row);
  if (record !== undefined) return { kind: 'record', formKey: record.formKey };
  if (plugin !== undefined) return { kind: 'plugin', ...plugin };
  if (downloaded !== undefined) return { kind: 'downloadedFile', name: downloaded };
  if (path !== undefined) return { kind: 'file', path };
  return modArgumentOf(row) ?? separatorArgumentOf(row);
}
