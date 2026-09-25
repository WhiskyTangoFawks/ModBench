import { FOLDER_KEY } from '../folderContext';

export const IN_AN_INSTANCE = `${FOLDER_KEY} == instance`;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A when clause read as VS Code reads it: `!` binds tightest, then `&&`, then `||`, and
// parentheses group. A term is everything between operators, a `=~` regex literal included.
type Clause =
  | { kind: 'term'; text: string }
  | { kind: 'not'; operand: Clause }
  | { kind: 'and' | 'or'; operands: Clause[] };

function tokenize(when: string): string[] {
  const tokens: string[] = [];
  let term = '';
  const endTerm = () => {
    if (term.trim() !== '') tokens.push(term.trim());
    term = '';
  };
  for (let i = 0; i < when.length; i++) {
    const rest = when.slice(i);
    if (rest.startsWith('&&') || rest.startsWith('||')) {
      endTerm();
      tokens.push(rest.slice(0, 2));
      i++;
    } else if (when[i] === '(' || when[i] === ')') {
      endTerm();
      tokens.push(when.charAt(i));
    } else if (when[i] === '!' && term.trim() === '' && when[i + 1] !== '=') {
      tokens.push('!');
    } else if (when[i] === '/' && term.trimEnd().endsWith('=~')) {
      const close = /^\/(?:\\.|[^\\/])*\/[a-z]*/.exec(rest);
      if (!close) throw new Error(`A when clause this scan cannot read: an unclosed regex in "${when}".`);
      term += close[0];
      i += close[0].length - 1;
    } else {
      term += when.charAt(i);
    }
  }
  endTerm();
  return tokens;
}

function parseClause(when: string): Clause {
  const tokens = tokenize(when);
  let at = 0;
  const unreadable = (why: string) => new Error(`A when clause this scan cannot read: ${why} in "${when}".`);
  const operand = (): Clause => {
    const token = tokens[at++];
    if (token === '!') return { kind: 'not', operand: operand() };
    if (token === '(') {
      const inner = alternatives();
      if (tokens[at++] !== ')') throw unreadable('an unclosed parenthesis');
      return inner;
    }
    if (token === undefined || token === ')' || token === '&&' || token === '||') throw unreadable(`"${token ?? 'the end'}" where a term belongs`);
    return { kind: 'term', text: token };
  };
  const conjuncts = (): Clause => {
    const first = operand();
    const operands = [first];
    while (tokens[at] === '&&') { at++; operands.push(operand()); }
    return operands.length === 1 ? first : { kind: 'and', operands };
  };
  const alternatives = (): Clause => {
    const first = conjuncts();
    const operands = [first];
    while (tokens[at] === '||') { at++; operands.push(conjuncts()); }
    return operands.length === 1 ? first : { kind: 'or', operands };
  };
  const clause = alternatives();
  if (at !== tokens.length) throw unreadable(`"${tokens[at] ?? ''}" left over`);
  return clause;
}

function holdsOnlyWhile(clause: Clause, term: string): boolean {
  switch (clause.kind) {
    case 'term': return clause.text === term;
    case 'not': return clause.operand.kind === 'term' && `!${clause.operand.text}` === term;
    case 'and': return clause.operands.some((c) => holdsOnlyWhile(c, term));
    case 'or': return clause.operands.every((c) => holdsOnlyWhile(c, term));
  }
}

/** Whether `when` holds only while `term` does. Throws on a clause it cannot read, so no entry
 *  slips out of a scan as ungated. */
export function requires(when: string | undefined, term: string): boolean {
  return when !== undefined && holdsOnlyWhile(parseClause(when), term);
}

/** Whether `when` holds in `context`: a term is `key == value`, `key != value`, `key =~ /re/`, or a
 *  key, true when set and not `false`. */
export function holds(when: string, context: Readonly<Record<string, string | boolean | undefined>>): boolean {
  const termHolds = (text: string): boolean => {
    const match = /^([\w.]+)\s*(==|!=|=~)\s*(.+)$/.exec(text);
    if (!match) return Boolean(context[text]);
    const [, key = '', op, operand = ''] = match;
    const value = String(context[key] ?? '');
    if (op === '==') return value === operand.replace(/^'(.*)'$/, '$1');
    if (op === '!=') return value !== operand.replace(/^'(.*)'$/, '$1');
    const regex = /^\/(.*)\/([a-z]*)$/.exec(operand);
    if (!regex) throw new Error(`A when clause this scan cannot read: "${operand}" is no regex in "${when}".`);
    return new RegExp(regex[1] ?? '', regex[2]).test(value);
  };
  const evaluate = (clause: Clause): boolean => {
    switch (clause.kind) {
      case 'term': return termHolds(clause.text);
      case 'not': return !evaluate(clause.operand);
      case 'and': return clause.operands.every(evaluate);
      case 'or': return clause.operands.some(evaluate);
    }
  };
  return evaluate(parseClause(when));
}
