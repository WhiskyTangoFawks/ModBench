const HEADER_PREFIX = '000000:';

interface TitledColumn { editorId?: string | null; isWinner: boolean }

/** The one place a record tab's title is derived. */
export function recordTitle(formKey: string, columns: readonly TitledColumn[] | undefined): string {
  if (formKey.startsWith(HEADER_PREFIX)) return formKey.slice(HEADER_PREFIX.length);
  const shown = columns?.find((c) => c.isWinner) ?? columns?.[0];
  return shown?.editorId ?? formKey;
}
