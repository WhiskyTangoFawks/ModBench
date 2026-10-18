import type { components } from './generated/api';
import { pluginRowName } from './pluginAddress';

/** A plugin's copy of a record. */
export type RecordCopy = Omit<components['schemas']['RecordCopy'], 'documentText'>;

export const holdsNoCopy = ({ formKey, plugin }: RecordCopy): string => `${pluginRowName(plugin)} holds no ${formKey}.`;
