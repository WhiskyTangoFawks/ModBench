import type { components } from '../wire/generated/api';
import type { Division } from './heldResults';

type PluginProblems = components['schemas']['PluginProblems'];
type PluginFilePaths = components['schemas']['PluginFilePaths'];
type SourceProblem = components['schemas']['SourceProblem'];

const keyed = <T>(rows: readonly T[], formKeyOf: (row: T) => string | null | undefined): Map<string, T[]> => {
  const byRecord = new Map<string, T[]>();
  for (const row of rows) {
    const key = (formKeyOf(row) ?? '').toLowerCase();
    byRecord.set(key, [...byRecord.get(key) ?? [], row]);
  }
  return byRecord;
};

const onceGrouped = <A extends object, T>(group: (answer: A) => Map<string, T[]>) => {
  const grouped = new WeakMap<A, Map<string, T[]>>();
  return (answer: A, formKey: string): T[] => {
    let groups = grouped.get(answer);
    if (!groups) { groups = group(answer); grouped.set(answer, groups); }
    return groups.get(formKey.toLowerCase()) ?? [];
  };
};

const problemsOf = onceGrouped((answer: PluginProblems) => keyed(answer.problems, ({ formKey }) => formKey));

export const problemsDivision: Division<PluginProblems, SourceProblem[]> = {
  partOf: (answer, { formKey }) => problemsOf(answer, formKey),
  isEmpty: (part) => part.length === 0,
  levelOf: () => '',
  join: (answer, parts) => ({ plugin: answer.plugin, problems: [...parts.values()].flat(), failure: answer.failure, failureKind: answer.failureKind, records: null }),
};

interface FilePathsPart { paths: PluginFilePaths['paths']; scripts: PluginFilePaths['scripts']; unread: string[] }

const pathsOf = onceGrouped((answer: PluginFilePaths) => keyed(answer.paths, ({ formKey }) => formKey));
const scriptsOf = onceGrouped((answer: PluginFilePaths) => keyed(answer.scripts, ({ formKey }) => formKey));

const stoppedOf = ({ unread, records }: PluginFilePaths): string[] => {
  const refused = new Set((records ?? []).flatMap((record) => record.unread));
  return unread.filter((line) => !refused.has(line));
};

export const filePathsDivision: Division<PluginFilePaths, FilePathsPart> = {
  partOf: (answer, { formKey, unread }) => ({ paths: pathsOf(answer, formKey), scripts: scriptsOf(answer, formKey), unread }),
  isEmpty: ({ paths, scripts, unread }) => paths.length === 0 && scripts.length === 0 && unread.length === 0,
  levelOf: (answer) => JSON.stringify(stoppedOf(answer)),
  join: (answer, parts) => ({
    plugin: answer.plugin,
    paths: [...parts.values()].flatMap((part) => part.paths),
    scripts: [...parts.values()].flatMap((part) => part.scripts),
    unread: [...stoppedOf(answer), ...[...parts.values()].flatMap((part) => part.unread)],
    failure: answer.failure,
    failureKind: answer.failureKind,
    records: null,
  }),
};
