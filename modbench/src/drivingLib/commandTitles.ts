const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The title of each command the extension's package.json contributes, by Command ID. */
export function commandTitles(packageJson: unknown): Map<string, string> {
  const contributes = isRecord(packageJson) ? packageJson['contributes'] : undefined;
  const commands = isRecord(contributes) ? contributes['commands'] : undefined;
  const titles = new Map<string, string>();
  if (!Array.isArray(commands)) return titles;
  for (const entry of commands as unknown[]) {
    if (isRecord(entry) && typeof entry['command'] === 'string' && typeof entry['title'] === 'string') titles.set(entry['command'], entry['title']);
  }
  return titles;
}
