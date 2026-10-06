import { findNodeAtLocation, parseTree, type Node } from 'jsonc-parser';
import type { MEditClient, PluginProblems } from '../client';
import type { OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey } from '../wire/pluginAddress';

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

// mEdit's field path is the document's own member names, an element's index in brackets.
const locationOf = (fieldPath: string): (string | number)[] =>
  fieldPath.split('.').flatMap((member) => [member.split('[')[0] ?? member, ...[...member.matchAll(/\[(\d+)\]/g)].map((index) => Number(index[1]))]);

function spanOf(scope: Node, { formKey, targetFormKey, fieldPath }: SourceProblem): Node | undefined {
  const spanned = targetFormKey ?? formKey;
  if (!spanned) return undefined;
  const atPath = fieldPath ? findNodeAtLocation(scope, locationOf(fieldPath)) : undefined;
  return atPath && isString(spanned)(atPath) ? atPath : find(scope, isString(spanned));
}

function onText(text: string, problem: SourceProblem): ProblemOnFile {
  const root = parseTree(text);
  const scope = root && problem.formKey ? (find(root, isRecord(problem.formKey)) ?? root) : root;
  const target = scope && spanOf(scope, problem);
  return target
    ? { message: problem.message, start: positionAt(text, target.offset), end: positionAt(text, target.offset + target.length) }
    : { message: problem.message, start: FIRST_LINE, end: FIRST_LINE };
}

interface Told { key: string; message: string; why: string }

function tellingOnce(say: (message: string, why: string) => void): (standing: Told[]) => void {
  let told = new Map<string, string>();
  return (standing) => {
    for (const { key, message, why } of standing) if (told.get(key) !== why) say(message, why);
    told = new Map(standing.map(({ key, why }) => [key, why]));
  };
}

async function placed(answer: PluginProblems[], { originFiles, readText }: SourceProblemsDeps): Promise<{ byFile: ProblemsByFile; unplaced: Told[]; unread: Told[] }> {
  const unplaced: Told[] = [];
  const cannotShow = (name: string) => `The Problems panel cannot show "${name}"'s problems.`;
  const byPath = new Map<string, SourceProblem[]>();
  for (const { plugin, problems, failure } of answer) {
    const files = originFiles(plugin.origin);
    const key = pluginAddressKey(plugin);
    const why = files === undefined ? `The instance holds no folder for ${plugin.origin}.` : failure;
    if (why != null) unplaced.push({ key, message: cannotShow(plugin.name), why });
    if (files !== undefined) for (const problem of problems) {
      const path = files.file(problem.sourceRelativePath);
      byPath.set(path, [...(byPath.get(path) ?? []), problem]);
    }
  }
  const unread: Told[] = [];
  const byFile = new Map(await Promise.all([...byPath].map(async ([path, onPath]) => {
    const text = await readText(path).catch((error: unknown) => {
      unread.push({ key: path, message: `The Problems panel shows the problems of "${path}" on its first line.`, why: errorMessage(error) });
      return '';
    });
    return [path, onPath.map((problem) => onText(text, problem))] as const;
  })));
  return { byFile, unplaced, unread };
}

/** Publishes what mEdit answers is wrong in each tracked active plugin's source whenever a save,
 *  a re-read plugin or a new active set can change it, and tells of an unplaced plugin once per
 *  reason (common.md, Reporting). */
export function feedSourceProblems(deps: SourceProblemsDeps): () => void {
  const { client, reporter, publish } = deps;
  const tellUnplaced = tellingOnce((message, why) => { reporter.report('warning', message, why); });
  const tellUnread = tellingOnce((message, why) => { reporter.shownOnSurface('warning', message, why); });
  let unanswered: string | undefined;
  const keepLastAnswer = (error: unknown) => {
    const why = errorMessage(error);
    if (why !== unanswered) reporter.shownOnSurface('warning', 'The Problems panel shows mEdit\'s last answer.', why);
    unanswered = why;
  };
  // Unknown until a load-order-status says, or mEdit answers the ask made at subscribe.
  let ready: boolean | undefined;
  let latest = 0;
  let shown = 0;
  const ask = async (atSubscribe = false) => {
    const mine = ++latest;
    try {
      const { byFile, unplaced, unread } = await placed(await client.getPluginProblems(), deps);
      if (atSubscribe) ready ??= true;
      if (mine < shown) return;
      shown = mine;
      unanswered = undefined;
      publish(byFile);
      tellUnplaced(unplaced);
      tellUnread(unread);
    } catch (error) {
      if (mine === latest && !atSubscribe) keepLastAnswer(error);
    }
  };
  const reask = () => { void ask(); };
  const reaskWhenReady = () => { if (ready) reask(); };
  const unsubscribe = [
    client.onNotification('load-order-status', (status) => { ready = status.conflictsComputed; reaskWhenReady(); }),
    client.onNotification('rows-changed', reaskWhenReady),
    client.onNotification('plugin-changed', reaskWhenReady),
    client.onReconnected(reask),
  ];
  void ask(true);
  return () => { for (const off of unsubscribe) off(); };
}
