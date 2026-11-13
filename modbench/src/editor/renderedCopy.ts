import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import type { PluginAddress } from '../wire/pluginAddress';
import { holdsNoCopy, type RecordCopy } from '../wire/recordCopy';

// What this lib reads of mEdit's answers, by shape: a lib references only boxes every box using it
// references (target-architecture.md, The rule is the reference list).
export interface RenderedCopyClient {
  getRenderedDocument(plugin: PluginAddress, formKey: string): Promise<{ text: string } | null | ReadFailed>;
}

/** The text mEdit renders of a copy of a plugin with no readable source (editor.md, Opening, story 9). */
export async function renderedCopy(client: RenderedCopyClient, copy: RecordCopy): Promise<{ text: string } | { refused: string }> {
  const rendered = await client.getRenderedDocument(copy.plugin, copy.formKey);
  if (isReadFailed(rendered)) return { refused: failureReason(rendered) };
  if (rendered === null) return { refused: holdsNoCopy(copy) };
  return { text: rendered.text };
}
