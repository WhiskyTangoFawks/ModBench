import { pluginRowName } from './pluginAddress';
import type { RecordCopy } from './messages';

export type { RecordCopy };

export type CopyChanged = (copy: RecordCopy) => boolean;

export const holdsNoCopy = ({ formKey, plugin }: RecordCopy): string => `${pluginRowName(plugin)} holds no ${formKey}.`;
