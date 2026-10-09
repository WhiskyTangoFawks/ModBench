/** "EditorID [FormKey]" when the record is named, the bare FormKey when it isn't. */
export function recordLabel(editorId: string | null | undefined, formKey: string): string {
  return editorId ? `${editorId} [${formKey}]` : formKey;
}
