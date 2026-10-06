import type * as vscode from 'vscode';
import { findNodeAtLocation, parseTree, type Node } from 'jsonc-parser';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { recordDocument, type RecordDocumentClient } from '../drivingLib/recordDocument';
import { formKeyAt } from './formKeyHover';

export interface TextSpan { start: number; end: number }

function ownMember(node: Node, formKey: string): Node | undefined {
  const value = node.type === 'object' ? findNodeAtLocation(node, ['FormKey']) : undefined;
  if (value?.value === formKey) return value.parent;
  for (const child of node.children ?? []) {
    const found = ownMember(child, formKey);
    if (found) return found;
  }
  return undefined;
}

/** The `FormKey` member of the object that is the record in a plugin source document: the
 *  document's own record, or a child record embedded in its owner's file. */
export function formKeyMember(text: string, formKey: string): TextSpan | undefined {
  const root = parseTree(text);
  const member = root && ownMember(root, formKey);
  return member && { start: member.offset, end: member.offset + member.length };
}

export interface DefinitionDeps<Document> {
  client: RecordDocumentClient;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  open: (uri: vscode.Uri) => PromiseLike<Document>;
}

export interface Definition<Document> extends TextSpan { uri: vscode.Uri; document: Document }

/** A refusal or a failure offers no definition, and is written to the Output once for each reason
 *  (common.md, Reporting). */
export function definitionsOf<Document extends { getText(): string }>(
  { client, reporter, open }: DefinitionDeps<Document>,
): (text: string, offset: number) => Promise<Definition<Document> | undefined> {
  const told = new Set<string>();
  const tell = (formKey: string, why: string) => {
    if (told.has(why)) return;
    told.add(why);
    reporter.shownOnSurface('warning', `Go to Definition cannot open ${formKey}.`, why);
  };
  return async (text, offset) => {
    const found = formKeyAt(text, offset);
    if (!found) return undefined;
    const { formKey } = found;
    try {
      const opened = await recordDocument(client, { formKey });
      if (!opened) return undefined;
      if ('refused' in opened) {
        tell(formKey, opened.refused);
        return undefined;
      }
      const document = await open(opened.uri);
      const member = formKeyMember(document.getText(), formKey);
      return member && { uri: opened.uri, document, ...member };
    } catch (error) {
      tell(formKey, errorMessage(error));
      return undefined;
    }
  };
}
