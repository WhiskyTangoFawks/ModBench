import { pluginRowName } from './pluginAddress';
import type { RecordCopy } from './messages';

export type { RecordCopy };

export const holdsNoCopy = ({ formKey, plugin }: RecordCopy): string => `${pluginRowName(plugin)} holds no ${formKey}.`;
