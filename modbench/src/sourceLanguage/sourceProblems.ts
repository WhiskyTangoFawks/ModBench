import { parseTree, type Node } from 'jsonc-parser';
import type { MEditClient, PluginProblems } from '../client';
import type { OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

type SourceProblem = PluginProblems['problems'][number];

export interface Position { line: number; character: number }
export interface ProblemOnFile { message: string; start: Position; end: Position }
/** Every problem mEdit answered, by the absolute path of the file it sits on. */
export type ProblemsByFile = ReadonlyMap<string, ProblemOnFile[]>;

export interface SourceProblemsDeps {
  client: Pick<MEditClient, 'getPluginProblems' | 'onNotification' | 'onReconnected'>;
  originFiles: OriginFilesOf;
  readText: (path: string) => Promise<string>;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
  /** Replaces every problem published before. */
  publish: (problems: ProblemsByFile) => void;
}

const FIRST_LINE = { line: 0, character: 0 };

function positionAt(text: string, offset: number): Position {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

const isPropertyName = (node: Node): boolean => node.parent?.type === 'property' && node.parent.children?.[0] === node;

function find(node: Node, matches: (candidate: Node) => boolean): Node | undefined {
  if (matches(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, matches);
    if (found) return found;
  }
  return undefined;
}

const isString = (value: string) => (node: Node): boolean => node.type === 'string' && node.value === value && !isPropertyName(node);

const isRecord = (formKey: string) => (node: Node): boolean =>
  node.type === 'object' && (node.children ?? []).some((member) => member.children?.[0]?.value === 'FormKey' && member.children[1]?.value === formKey);

function onText(text: string, problem: SourceProblem): ProblemOnFile {
  const root = parseTree(text);
  const scope = root && (find(root, isRecord(problem.formKey)) ?? root);
  const target = scope && find(scope, isString(problem.targetFormKey));
  return target
    ? { message: problem.message, start: positionAt(text, target.offset), end: positionAt(text, target.offset + target.length) }
    : { message: problem.message, start: FIRST_LINE, end: FIRST_LINE };
}

interface Unplaced { plugin: PluginAddress; why: string }

async function placed(answer: PluginProblems[], { originFiles, readText }: SourceProblemsDeps): Promise<{ byFile: ProblemsByFile; unplaced: Unplaced[] }> {
  const unplaced: Unplaced[] = [];
  const byPath = new Map<string, SourceProblem[]>();
  for (const { plugin, problems, failure } of answer) {
    const files = originFiles(plugin.origin);
    if (failure != null) unplaced.push({ plugin, why: failure });
    else if (files === undefined) unplaced.push({ plugin, why: `The instance holds no folder for ${plugin.origin}.` });
    else for (const problem of problems) {
      const path = files.file(problem.sourceRelativePath);
      byPath.set(path, [...(byPath.get(path) ?? []), problem]);
    }
  }
  const byFile = new Map(await Promise.all([...byPath].map(async ([path, onPath]) => {
    const text = await readText(path).catch(() => '');
    return [path, onPath.map((problem) => onText(text, problem))] as const;
  })));
  return { byFile, unplaced };
}

/** Publishes what mEdit answers is wrong in each tracked active plugin's source whenever a save,
 *  a re-read plugin or a new active set can change it, and tells of an unplaced plugin once per
 *  reason (common.md, Reporting). */
export function feedSourceProblems(deps: SourceProblemsDeps): () => void {
  const { client, reporter, publish } = deps;
  let told = new Map<string, string>();
  const tell = (unplaced: Unplaced[]) => {
    for (const { plugin, why } of unplaced) {
      if (told.get(pluginAddressKey(plugin)) !== why) reporter.report('warning', `The Problems panel cannot show "${plugin.name}"'s problems.`, why);
    }
    told = new Map(unplaced.map(({ plugin, why }) => [pluginAddressKey(plugin), why]));
  };
  let unanswered: string | undefined;
  const keepLastAnswer = (error: unknown) => {
    const why = errorMessage(error);
    if (why !== unanswered) reporter.shownOnSurface('warning', 'The Problems panel shows mEdit\'s last answer.', why);
    unanswered = why;
  };
  let latest = 0;
  const ask = async () => {
    const mine = ++latest;
    try {
      const { byFile, unplaced } = await placed(await client.getPluginProblems(), deps);
      if (mine !== latest) return;
      unanswered = undefined;
      publish(byFile);
      tell(unplaced);
    } catch (error) {
      keepLastAnswer(error);
    }
  };
  const reask = () => { void ask(); };
  const unsubscribe = [
    client.onNotification('load-order-status', (status) => { if (status.conflictsComputed) reask(); }),
    client.onNotification('rows-changed', reask),
    client.onNotification('plugin-changed', reask),
    client.onReconnected(reask),
  ];
  return () => { for (const off of unsubscribe) off(); };
}
